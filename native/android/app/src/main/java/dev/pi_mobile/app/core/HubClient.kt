package dev.pi_mobile.app.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * One sealed connection to one computer (plans/native-apps.md §1): RPC plus the event stream.
 * The app keeps one client per machine; no machine relays for another. Port of native/ios/Pi/Core/HubClient.swift.
 *
 * @param client a shared OkHttp client; this class derives its own RPC and stream clients from it so the
 *   connection pool is shared while redirects stay refused ([RedirectGuard]).
 * @param clock wall-clock milliseconds for the `t` every sealed payload carries (tests pin it).
 * @throws HubError when the stored key is damaged or the origin isn't allowed ([OriginPolicy]).
 */
class HubClient(
    val machine: Machine,
    client: OkHttpClient = defaultClient,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    sealed interface Update {
        data class State(val state: ConnectionState) : Update
        data class Event(val event: HubEvent) : Update
    }

    private val key: ByteArray = machine.key?.takeIf { it.size == Envelope.KEY_BYTES }
        ?: throw HubError.Network("That computer's key is damaged. Pair it again.")

    init {
        OriginPolicy.problem(machine.origin)?.let { throw HubError.Remote(it) }
    }

    private val rpcClient = rpcClient(client)

    /** No read timeout: the stall watchdog decides when a quiet stream is dead. */
    private val streamClient = client.newBuilder()
        .followRedirects(false).followSslRedirects(false)
        .connectTimeout(TIMEOUT_S, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
        .addInterceptor(RedirectGuard)
        .build()

    /** Reconnect delay doubles from the lower to the upper bound; reset by each `hello`. */
    @Volatile private var backoffMinMs = 500L
    @Volatile private var backoffMaxMs = 8_000L
    /** The hub pings every 15 s; mobile networks drop sockets silently. */
    @Volatile private var stallTimeoutMs = 40_000L
    @Volatile private var delayMs = backoffMinMs

    @Volatile var hubId: String? = null
        private set
    @Volatile var seq: Int = 0
        private set
    @Volatile var clientId: String? = null
        private set
    @Volatile var focused: String = ""
        private set

    /** Shorter delays for tests; production uses the defaults (0.5–8 s backoff, 40 s stall). */
    fun configure(backoffMinMs: Long = this.backoffMinMs, backoffMaxMs: Long = this.backoffMaxMs, stallTimeoutMs: Long = this.stallTimeoutMs) {
        this.backoffMinMs = backoffMinMs
        this.backoffMaxMs = backoffMaxMs
        this.stallTimeoutMs = stallTimeoutMs
        delayMs = backoffMinMs
    }

    // RPC

    suspend fun rpc(m: String, p: JsonObject = EmptyObject): JsonElement {
        val body = obj("d" to machine.d, "b" to Envelope.seal(key, obj("t" to clock(), "m" to m, "p" to p)))
        val (status, reply) = post(rpcClient, "${machine.origin}/api/rpc", body)
        if (status == 401) throw HubError.Unauthorized
        val sealed = reply["b"].string ?: throw HubError.Remote(reply["error"].string ?: "HTTP $status")
        val out = Envelope.open(key, sealed) ?: throw HubError.Network(UNREADABLE)
        val e = out["e"]
        if (!e.isNull) throw HubError.Remote(e.string ?: "error")
        return out["r"] ?: JsonNull
    }

    /** Forwards method [m] to one pi session on this computer. */
    suspend fun agent(agent: String, m: String, p: JsonObject = EmptyObject): JsonElement =
        rpc("agent", obj("agent" to agent, "m" to m, "p" to p))

    suspend fun hub(): HubInfo = HubInfo(rpc("hub"))

    /** Detailed events (token stream, tool output) flow only for the focused session. Kept across reconnects. */
    suspend fun focus(agent: String) {
        focused = agent
        val client = clientId ?: return
        rpc("focus", obj("client" to client, "agent" to agent))
    }

    // Events

    /** `GET /api/stream` resuming from the last `hubId`/`seq`, with the focused session. */
    internal fun streamRequest(): Request {
        val payload = mutableMapOf<String, Any?>("t" to clock(), "since" to seq)
        hubId?.let { payload["hub"] = it }
        if (focused.isNotEmpty()) payload["focus"] = focused
        val url = "${machine.origin}/api/stream".toHttpUrlOrNull()?.newBuilder()
            ?.addQueryParameter("d", machine.d)
            ?.addQueryParameter("b", Envelope.seal(key, jsonOf(payload)))
            ?.build() ?: throw HubError.Network(BAD_ADDRESS)
        return Request.Builder().url(url).header("Accept", "text/event-stream").header("Cache-Control", "no-cache").build()
    }

    /**
     * The event stream with reconnects (backoff, stall detection, `since` resumption, re-focus after `hello`).
     * Ends with [HubError.Unauthorized] when the phone was removed; otherwise runs until the collector stops.
     */
    fun updates(): Flow<Update> = channelFlow {
        delayMs = backoffMinMs
        while (true) {
            send(Update.State(ConnectionState.CONNECTING))
            try {
                connectOnce(channel)
            } catch (e: CancellationException) {
                throw e
            } catch (e: HubError.Unauthorized) {
                throw e
            } catch (_: Exception) {
                // Dropped, refused or stalled: retried below.
            }
            clientId = null
            send(Update.State(ConnectionState.OFFLINE))
            delay(delayMs)
            delayMs = minOf(delayMs * 2, backoffMaxMs)
        }
    }

    private suspend fun connectOnce(out: SendChannel<Update>) {
        val call = streamClient.newCall(streamRequest())
        val stall = stallTimeoutMs
        val last = AtomicLong(System.nanoTime())
        fun touch() = last.set(System.nanoTime())
        coroutineScope {
            // Also the one place the blocking read is unblocked: cancelling this scope (collector gone,
            // reader finished) runs the finally and cancels the call.
            launch {
                try {
                    while (true) {
                        delay(minOf(5_000L, stall / 4))
                        if ((System.nanoTime() - last.get()) / 1_000_000 > stall) throw HubError.Network("stalled")
                    }
                } finally {
                    call.cancel()
                }
            }
            withContext(Dispatchers.IO) {
                call.execute().use { resp ->
                    if (resp.code == 401) throw HubError.Unauthorized
                    if (resp.code != 200) throw HubError.Network("HTTP ${resp.code}")
                    touch()
                    val source = resp.body!!.source()
                    val parser = SseParser()
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = source.read(buf)
                        if (n < 0) break
                        for (item in parser.feed(buf, 0, n)) {
                            touch()
                            if (item is SseParser.Item.Message) batch(item.data, out)
                        }
                    }
                }
            }
            throw HubError.Network("closed")
        }
    }

    private suspend fun batch(sealed: String, out: SendChannel<Update>) {
        val list = Envelope.open(key, sealed).array ?: return
        for (raw in list) {
            val ev = HubEvent(raw)
            val s = ev.seq
            if (ev.type == "hello") {
                delayMs = backoffMinMs
                hubId = raw["hubId"].string
                seq = raw["seq"].int ?: 0
                clientId = raw["client"].string
                out.send(Update.State(ConnectionState.ONLINE))
                if (focused.isNotEmpty()) {
                    try { focus(focused) } catch (e: CancellationException) { throw e } catch (_: Exception) {}
                }
            } else if (s != null) {
                seq = maxOf(seq, s)
            }
            out.send(Update.Event(ev))
        }
    }

    companion object {
        private const val TIMEOUT_S = 30L
        private const val UNREADABLE = "The computer's reply could not be read."
        private const val BAD_ADDRESS = "That address isn't valid."
        private val JSON_TYPE = "application/json".toMediaType()

        /** One pool for every computer; per-purpose clients derive from it. */
        val defaultClient: OkHttpClient by lazy { OkHttpClient() }

        private fun rpcClient(client: OkHttpClient): OkHttpClient = client.newBuilder()
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(TIMEOUT_S, TimeUnit.SECONDS).readTimeout(TIMEOUT_S, TimeUnit.SECONDS).writeTimeout(TIMEOUT_S, TimeUnit.SECONDS)
            .addInterceptor(RedirectGuard)
            .build()

        /**
         * Pairs with the computer that showed [link] (single use, 10 min). The result is the primary machine.
         * [name] is how this phone is listed on the computer (the app passes "Android · pi app").
         */
        suspend fun pair(link: PairingLink, name: String, client: OkHttpClient = defaultClient, nowMs: Long = System.currentTimeMillis()): Machine {
            OriginPolicy.problem(link.origin)?.let { throw HubError.Remote(it) }
            val body = obj("p" to link.id, "b" to Envelope.seal(link.key, obj("t" to nowMs, "name" to name)))
            val (status, reply) = post(rpcClient(client), "${link.origin}/api/pair", body)
            when (status) {
                410 -> throw HubError.Expired
                401, 404 -> throw HubError.Remote("That code isn't valid. Run /remote on your computer and scan the new code.")
            }
            val sealed = reply["b"].string ?: throw HubError.Remote(reply["error"].string ?: "Pairing failed (HTTP $status).")
            val out = Envelope.open(link.key, sealed)
            val d = out["d"].string
            val k = out["k"].string
            val host = out["host"].string
            if (d == null || k == null || host == null) throw HubError.Network(UNREADABLE)
            return Machine(machine = out["machine"]["id"].string ?: "", name = host, origin = link.origin, d = d, k = k, primary = true)
        }

        /** The HTTP status and the JSON body (an empty object when the body isn't JSON). */
        private suspend fun post(client: OkHttpClient, url: String, body: JsonElement): Pair<Int, JsonElement> {
            val u: HttpUrl = url.toHttpUrlOrNull() ?: throw HubError.Network(BAD_ADDRESS)
            val req = Request.Builder().url(u).post(body.encode().toRequestBody(JSON_TYPE)).build()
            val resp = try { client.newCall(req).await() } catch (e: CancellationException) { throw e } catch (e: Exception) { throw e.toHubError() }
            return resp.use {
                val text = try { it.body?.string() ?: "" } catch (e: IOException) { throw e.toHubError() }
                it.code to (try { parseJson(text) } catch (_: Exception) { EmptyObject })
            }
        }

        private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { cancel() }
            enqueue(object : Callback {
                override fun onResponse(call: Call, response: Response) = cont.resume(response)
                override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)
            })
        }
    }
}

/** A failure as the sentence the UI shows (same wording as the iOS app). */
fun Throwable.toHubError(): HubError = when {
    this is HubError -> this
    this is InterruptedIOException -> HubError.Network("Your computer didn't answer in time.")
    isOffline() -> HubError.Network("You're offline.")
    this is IOException -> HubError.Network("Can't reach your computer.")
    else -> HubError.Network(message ?: "Can't reach your computer.")
}

/** No network at all (airplane mode, no route), as opposed to a computer that doesn't answer. */
private fun Throwable.isOffline(): Boolean {
    if (this is NoRouteToHostException) return true
    val m = message ?: return false
    return this is SocketException && ("ENETUNREACH" in m || "Network is unreachable" in m || "ECONNABORTED" in m)
}
