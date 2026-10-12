package dev.pi_mobile.app

import android.content.Context
import dev.pi_mobile.app.core.EmptyObject
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.RedirectGuard
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.isNull
import dev.pi_mobile.app.core.jsonOf
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import dev.pi_mobile.app.push.FirebaseSetup
import dev.pi_mobile.app.push.NotificationPermission
import dev.pi_mobile.app.push.PushController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Android notifications through the push relay (plans/native-android.md "Push", step 7): the FCM token is
 * registered at `POST <relay>/v1/register {platform: "fcm", token}` for a capability, and every paired
 * computer gets `push {relay: {url, cap}}`, so no computer needs Google credentials and Google never sees
 * what a notification says. Permission is asked only when the user turns notifications on in the web's
 * menu (BRIDGE.md `push.enable`). Port of the relay path of native/ios/Pi/App/PushCenter.swift.
 *
 * Android has no direct path (the iOS self-build sends APNs tokens to each computer), so there is no
 * `apns` token to take back either: the hub keys tokens by device, and this phone's device never sent one.
 *
 * @param relay the relay's https address; null means this build has no push (no Firebase configuration).
 * @param machines the paired computers, in the stored order.
 * @param hubs reaches one computer (a fake in tests).
 * @param token asks Firebase for the current FCM token.
 * @param now wall-clock milliseconds for the relay back-off (tests move it).
 */
class PushCenter(
    private val prefs: Prefs,
    private val machines: () -> List<Machine>,
    private val hubs: HubRpc,
    private val permission: NotificationPermission,
    private val token: suspend () -> String?,
    private val relay: HttpUrl?,
    http: OkHttpClient = HubClient.defaultClient,
    private val now: () -> Long = System::currentTimeMillis,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) : PushController {
    /** One RPC to one computer. */
    fun interface HubRpc {
        suspend fun rpc(machine: Machine, method: String, params: JsonObject): JsonElement
    }

    /** The Application holds the one PushCenter, so FCM callbacks ([dev.pi_mobile.app.push.PiMessagingService]) find it. */
    interface Host {
        val pushCenter: PushCenter
    }

    /** Failures as the sentence the web shows. */
    open class Failure(message: String) : Exception(message)

    /** 501 from the relay: it runs but can't push to FCM yet. Push isn't available yet. */
    class RelayNotReady : Failure("Notifications aren't available yet. Try again later.")

    /** The relay registers no further than its own redirects allow (the RedirectGuard rule, A5). */
    private val http = http.newBuilder()
        .followRedirects(false).followSslRedirects(false)
        .callTimeout(20, TimeUnit.SECONDS)
        .addInterceptor(RedirectGuard)
        .build()

    /** What computers store: the relay's address without a trailing slash, as the hub normalises it. */
    private val relayUrl: String? = relay?.toString()?.trimEnd('/')

    val available: Boolean get() = relay != null

    /** Reconciles, registers and the enable flow run one at a time: they all read and write the same state. */
    private val lock = Mutex()

    /**
     * After the last reconcile with notifications on: each computer's entry id → null when it will notify
     * this phone, else why not (one line per computer in the web menu, BRIDGE.md `push.status`).
     */
    @Volatile var notifyStatus: Map<String, String?> = emptyMap()
        private set
    val notifyingCount: Int get() = notifyStatus.values.count { it == null }

    /** Why the last relay register failed; the reason each computer shows while there is no cap. */
    @Volatile var lastRelayError: Failure? = null
        private set

    private val on: Boolean get() = available && prefs.notificationsOn

    // Triggers

    /**
     * At launch. A token can change (restore, reinstall, Play services data cleared), so it is asked for
     * again while notifications are on, and every computer hears again.
     */
    fun start() {
        scope.launch {
            if (on && permission.state() == "granted") {
                val t = token()
                lock.withLock {
                    prefs.pushRegistered = emptySet()
                    t?.let { takeToken(it) }
                }
            }
            reconcile()
        }
    }

    /** Foreground, a computer added or removed: brings every computer in line (and retries a missed off). */
    fun refresh() {
        scope.launch { reconcile() }
    }

    /** FCM issued a new token (`onNewToken`): computers holding a cap for the old one get a new cap. */
    fun tokenChanged(token: String) {
        scope.launch {
            lock.withLock { takeToken(token) }
            reconcile()
        }
    }

    private fun takeToken(t: String) {
        if (t != prefs.pushToken) prefs.pushRegistered = emptySet()
        prefs.pushToken = t
    }

    // Computers

    /**
     * What each computer should hold, from its own `hub` answer (`relay`, `relayOn`): the relay cap while
     * notifications are on, nothing while off. Runs at launch, on foreground, when a computer is added and
     * after a change, so an off that a sleeping computer missed is retried until it lands.
     */
    suspend fun reconcile() = lock.withLock { reconcileLocked() }

    private suspend fun reconcileLocked() {
        val on = on
        if (on && prefs.pushToken != null && prefs.relayCap == null) registerRelay()
        val list = machines()
        val why = mutableMapOf<String, String>()
        for (m in list) {
            val hub = try {
                hubs.rpc(m, "hub", EmptyObject)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                why[m.id] = "isn't reachable right now"
                continue
            }
            if (hub["relay"].bool != true) {
                why[m.id] = "runs an older pi-mobile: update it there"
                continue
            }
            val target = relayUrl.takeIf { on }
            val relayOn = hub["relayOn"].bool ?: false
            var step = relayAction(target, prefs.relayCap, relayOn, relayTag(m) in prefs.pushRegistered)
            if (step.reregister) registerRelay()?.let { fresh -> step = relayAction(target, fresh, relayOn = false, sent = false) }
            if (on && prefs.relayCap == null) why[m.id] = lastRelayError?.message ?: "the notification relay can't be reached"
            val p = step.rpc ?: continue
            try {
                hubs.rpc(m, "push", p)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (on) why[m.id] = e.message ?: "isn't reachable right now"
                continue
            }
            prefs.pushRegistered = if (p["relay"].isNull) prefs.pushRegistered - relayTag(m) else prefs.pushRegistered + relayTag(m)
        }
        notifyStatus = if (on) list.associate { it.id to why[it.id] } else emptyMap()
    }

    /** Sent when this computer, device and cap match: a new computer, a re-pair or a new cap sends again. */
    private fun relayTag(m: Machine) = "relay|${m.id}|${m.d}|${prefs.relayCap ?: ""}"

    // Relay

    /**
     * A fresh capability for the current token (stored), or null when the relay can't give one. Unless
     * [force]d (turning notifications on), nothing is tried while paused: 501 pauses 6 hours, other failures
     * 5 minutes, so launches, foregrounds and added computers never hammer a relay that can't answer.
     */
    private suspend fun registerRelay(force: Boolean = false): String? {
        val relay = relay ?: return null
        val token = prefs.pushToken ?: return null
        val until = prefs.relayPausedUntilMs
        if (!force && until != null && now() < until) return null
        val cap = try {
            requestCap(relay, token)
        } catch (e: Failure) {
            lastRelayError = e
            prefs.relayPausedUntilMs = now() + if (e is RelayNotReady) NOT_READY_PAUSE_MS else FAILURE_PAUSE_MS
            return null
        }
        lastRelayError = null
        prefs.relayPausedUntilMs = null
        prefs.pushRegistered = prefs.pushRegistered.filterTo(mutableSetOf()) { !it.startsWith("relay|") }
        prefs.relayCap = cap
        return cap
    }

    private suspend fun requestCap(relay: HttpUrl, token: String): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(relay.newBuilder().addPathSegments("v1/register").build())
            .post(obj("platform" to "fcm", "token" to token).encode().toRequestBody(JSON_TYPE))
            .build()
        try {
            http.newCall(req).execute().use { relayCap(it.code, it.body?.string() ?: "") }
        } catch (_: IOException) {
            throw Failure(RELAY_UNREACHABLE)
        }
    }

    // The web's Notifications row (BRIDGE.md `push.status`, `push.enable`)

    override suspend fun status(): JsonElement {
        val p = permission.state()
        // On only when something is registered: at least one computer will notify this phone.
        val isOn = on && p == "granted" && prefs.pushToken != null && notifyingCount > 0
        val computers = notifyStatus.toSortedMap().map { (id, why) ->
            jsonOf(mapOf("machine" to id, "notify" to (why == null)) + (why?.let { mapOf("why" to it) } ?: emptyMap()))
        }
        return obj("on" to isOn, "permission" to p, "available" to available, "computers" to computers)
    }

    override suspend fun enable(on: Boolean): JsonElement {
        if (!on) {
            // Persisted first: computers that miss the off now get it at the next reconcile.
            prefs.notificationsOn = false
            reconcile()
            return status()
        }
        if (!available) throw Failure("Notifications aren't available in this build of the app.")
        if (!permission.request()) throw Failure("Notifications are off for pi. Turn them on in Settings.")
        prefs.notificationsOn = true
        val t = token()
        lock.withLock {
            if (t == null) {
                prefs.notificationsOn = false
                throw Failure("This phone can't get notifications right now (it needs Google Play services). Try again later.")
            }
            takeToken(t)
            if (prefs.relayCap == null && registerRelay(force = true) == null) {
                prefs.notificationsOn = false
                throw lastRelayError as? RelayNotReady ?: Failure(RELAY_UNREACHABLE)
            }
            reconcileLocked()
            // Never "on" with nothing registered: say which computer can't and why.
            if (notifyingCount == 0) {
                prefs.notificationsOn = false
                val names = machines().associate { it.id to it.name }
                val reasons = notifyStatus.mapNotNull { (id, why) -> why?.let { "${names[id] ?: "Your computer"} $it" } }.sorted()
                reconcileLocked()
                throw Failure(if (reasons.isEmpty()) "Pair a computer first." else "No computer can notify this phone yet. ${reasons.joinToString("; ")}.")
            }
        }
        return status()
    }

    /** The `push` RPC for one computer through the relay; [reregister] when it dropped a cap it was sent. */
    data class RelayStep(val reregister: Boolean, val rpc: JsonObject?)

    companion object {
        const val NOT_READY_PAUSE_MS = 6 * 3_600_000L
        const val FAILURE_PAUSE_MS = 5 * 60_000L
        private const val RELAY_UNREACHABLE = "Couldn't reach the notification relay. Try again later."
        private val JSON_TYPE = "application/json".toMediaType()

        /**
         * The production instance: the relay from BuildConfig, but only when this build has a Firebase
         * configuration (without it there is no token to register).
         */
        fun create(
            context: Context,
            permission: NotificationPermission,
            machines: () -> List<Machine>,
            hubs: HubRpc = HubRpc { m, method, p -> HubClient(m).rpc(method, p) },
        ): PushCenter {
            val app = context.applicationContext
            val relay = relayUrl(BuildConfig.RELAY_URL).takeIf { FirebaseSetup.init(app) }
            return PushCenter(Prefs(app), machines, hubs, permission, { FirebaseSetup.token(app) }, relay)
        }

        /** An https address without query or fragment (what the hub accepts), else null. */
        fun relayUrl(s: String): HttpUrl? {
            val u = s.trim().toHttpUrlOrNull() ?: return null
            return u.takeIf { it.isHttps && it.query == null && it.fragment == null && it.username.isEmpty() }
        }

        /** The relay's answer to register: the cap, or why not as a [Failure]. */
        fun relayCap(status: Int, body: String): String = when (status) {
            200, 201 -> (try { parseJson(body)["cap"].string } catch (_: Exception) { null })?.takeIf { it.isNotEmpty() }
                ?: throw Failure("The notification relay answered oddly. Try again later.")
            429 -> throw Failure("The notification relay is busy. Try again in a minute.")
            501 -> throw RelayNotReady()
            else -> throw Failure("The notification relay refused this phone (HTTP $status). Try again later.")
        }

        /**
         * What one computer needs: with notifications on ([url] non-null) and a [cap], the cap unless it
         * already holds the one sent; off, `{relay: null}` while it still reports one. A computer that
         * dropped a cap it was sent (the relay told it the cap is dead) asks for a fresh registration.
         */
        fun relayAction(url: String?, cap: String?, relayOn: Boolean, sent: Boolean): RelayStep {
            if (url == null || cap == null) return RelayStep(false, if (relayOn) obj("relay" to null) else null)
            if (relayOn && sent) return RelayStep(false, null)
            return RelayStep(!relayOn && sent, obj("relay" to obj("url" to url, "cap" to cap)))
        }
    }
}
