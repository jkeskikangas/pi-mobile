package dev.pi_mobile.app.core

import dev.pi_mobile.app.core.HubClient.Update
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** Port of native/ios/PiTests/HubClientTests.swift against MockWebServer. */
class HubClientTest {
    private val key = ByteArray(32) { (it + 7).toByte() }
    private val pairKey = ByteArray(32) { (200 - it).toByte() }
    private val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private val origin = server.url("/").toString().trimEnd('/')
    private val machine = Machine(id = "m1", name = "Laptop", origin = origin, d = "dev1", k = Base64Url.encode(key), primary = true)
    private val recorded = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()

    @After fun stop() = server.shutdown()

    private fun serve(handler: (RecordedRequest, String) -> MockResponse) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                recorded.add(request to body)
                return handler(request, body)
            }
        }
    }

    private fun sealedReply(k: ByteArray, value: JsonElement, status: Int = 200) =
        MockResponse().setResponseCode(status).setBody(obj("b" to Envelope.seal(k, value)).encode())

    private fun opened(body: String, k: ByteArray = key) = Envelope.open(k, parseJson(body)["b"].string!!)

    private suspend fun failure(block: suspend () -> Unit): Throwable =
        try { block(); fail("should throw"); error("unreachable") } catch (e: Throwable) { e }

    @Test fun pairRequestShapeAndResult() = runBlocking {
        serve { _, _ ->
            sealedReply(pairKey, obj("d" to "dev9", "k" to Base64Url.encode(ByteArray(32) { 1 }), "role" to "control", "host" to "MacBook Pro",
                "machine" to obj("id" to "fx-laptop", "name" to "MacBook Pro")))
        }
        val link = PairingLink.parse("$origin/#p=pid.${Base64Url.encode(pairKey)}")!!
        val m = HubClient.pair(link, "Android · pi app", nowMs = 1_760_000_000_000)
        assertEquals("dev9", m.d)
        assertEquals("MacBook Pro", m.name)
        assertEquals("fx-laptop", m.machine)
        assertEquals(origin, m.origin)
        assertTrue(m.primary)

        val (req, body) = recorded.single()
        assertEquals("POST", req.method)
        assertEquals("/api/pair", req.path)
        assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
        assertEquals("pid", parseJson(body)["p"].string)
        assertEquals(obj("t" to 1_760_000_000_000, "name" to "Android · pi app"), opened(body, pairKey))
    }

    @Test fun pairErrors() = runBlocking {
        val link = PairingLink.parse("$origin/#p=pid.${Base64Url.encode(pairKey)}")!!
        serve { _, _ -> MockResponse().setResponseCode(410).setBody("""{"error":"pairing expired"}""") }
        assertSame(HubError.Expired, failure { HubClient.pair(link, "x") })
        serve { _, _ -> MockResponse().setResponseCode(404) }
        assertEquals("That code isn't valid. Run /remote on your computer and scan the new code.", failure { HubClient.pair(link, "x") }.message)
        serve { _, _ -> sealedReply(key, obj("d" to "x")) }
        assertEquals("The computer's reply could not be read.", failure { HubClient.pair(link, "x") }.message)
    }

    @Test fun rpcShapeResultAndErrors() = runBlocking {
        var reply: JsonElement = obj("r" to obj("hubId" to "h1", "host" to "Laptop", "seq" to 3, "protocol" to 2, "features" to listOf("voice"), "agents" to emptyList<Any>()))
        var status = 200
        serve { _, _ -> sealedReply(key, reply, status) }
        val c = HubClient(machine, clock = { 1_000_000 })
        val info = c.hub()
        assertEquals("h1", info.hubId)
        assertEquals(2, info.protocolVersion)
        assertEquals(listOf("voice"), info.features)

        val (req, body) = recorded.last()
        assertEquals("/api/rpc", req.path)
        assertEquals("dev1", parseJson(body)["d"].string)
        assertEquals(obj("t" to 1_000_000, "m" to "hub", "p" to EmptyObject), opened(body))

        c.agent("a1", "send", obj("text" to "hi", "mode" to "steer"))
        assertEquals(obj("agent" to "a1", "m" to "send", "p" to obj("text" to "hi", "mode" to "steer")), opened(recorded.last().second)["p"])

        reply = obj("e" to "unknown method")
        val remote = failure { c.rpc("nope") }
        assertTrue(remote is HubError.Remote)
        assertEquals("unknown method", remote.message)
        status = 401
        assertSame(HubError.Unauthorized, failure { c.rpc("hub") })
    }

    @Test fun rpcWithoutASealedReplyShowsTheHubsError() = runBlocking {
        serve { _, _ -> MockResponse().setResponseCode(500).setBody("""{"error":"stale request"}""") }
        assertEquals("stale request", failure { HubClient(machine).rpc("hub") }.message)
        serve { _, _ -> MockResponse().setResponseCode(502).setBody("<html>") }
        assertEquals("HTTP 502", failure { HubClient(machine).rpc("hub") }.message)
        serve { _, _ -> MockResponse().setBody(obj("b" to Envelope.seal(pairKey, obj("r" to 1))).encode()) }
        assertEquals("The computer's reply could not be read.", failure { HubClient(machine).rpc("hub") }.message)
    }

    @Test fun redirectsOffTheOriginAreRefused() = runBlocking {
        serve { req, _ ->
            when (req.path) {
                "/api/rpc" -> MockResponse().setResponseCode(302).setHeader("Location", "http://evil.example/api/rpc")
                else -> error("followed")
            }
        }
        assertEquals("HTTP 302", failure { HubClient(machine).rpc("hub") }.message)
        assertEquals(1, recorded.size)

        // The same origin is fine (307 keeps the sealed body).
        recorded.clear()
        serve { req, _ ->
            if (req.path == "/api/rpc") MockResponse().setResponseCode(307).setHeader("Location", "/api/rpc2")
            else sealedReply(key, obj("r" to "ok"))
        }
        assertEquals("ok", HubClient(machine).rpc("hub").string)
        assertEquals(listOf("/api/rpc", "/api/rpc2"), recorded.map { it.first.path })
        assertEquals("hub", opened(recorded.last().second)["m"].string)
    }

    @Test fun constructorRefusesADamagedKey() {
        val e = assertThrows(HubError.Network::class.java) { HubClient(machine.copy(k = "short")) }
        assertEquals("That computer's key is damaged. Pair it again.", e.message)
    }

    @Test fun errorsAreSentences() {
        assertEquals("Your computer didn't answer in time.", SocketTimeoutException("timeout").toHubError().message)
        assertEquals("You're offline.", java.net.ConnectException("failed to connect: connect failed: ENETUNREACH (Network is unreachable)").toHubError().message)
        assertEquals("Can't reach your computer.", UnknownHostException("box.ts.net").toHubError().message)
        assertSame(HubError.Unauthorized, HubError.Unauthorized.toHubError())
    }

    @Test fun streamRequestCarriesResumeState() = runBlocking {
        val c = HubClient(machine, clock = { 2000 })
        c.focus("agentA") // no client id yet: remembered, sent with the next connect
        val req = c.streamRequest()
        assertEquals("/api/stream", req.url.encodedPath)
        assertEquals("text/event-stream", req.header("Accept"))
        assertEquals("dev1", req.url.queryParameter("d"))
        assertEquals(obj("t" to 2000, "since" to 0, "focus" to "agentA"), Envelope.open(key, req.url.queryParameter("b")!!))
        assertTrue(recorded.isEmpty())
    }

    @Test fun updatesDecodeBatchesTrackHelloAndReconnect() = runBlocking {
        val hello = Envelope.seal(key, jsonOf(listOf(
            obj("type" to "hello", "hubId" to "H", "seq" to 5, "resync" to true, "client" to "c1"),
            obj("type" to "info", "agent" to "a1", "seq" to 6, "info" to EmptyObject),
        )))
        serve { req, _ ->
            // Small chunks split lines anywhere: the parser must not care.
            if (req.path!!.startsWith("/api/stream")) MockResponse().setChunkedBody(": ping\n\ndata: $hello\n\n", 20)
            else sealedReply(key, obj("r" to true))
        }
        val c = HubClient(machine)
        c.configure(backoffMinMs = 10, backoffMaxMs = 20)
        c.focus("a1")
        var offline = 0
        val seen = withTimeout(10_000) {
            c.updates().takeWhile { u -> !(u == Update.State(ConnectionState.OFFLINE) && ++offline == 2) }.toList()
        }
        assertEquals(Update.State(ConnectionState.CONNECTING), seen.first())
        assertTrue(Update.State(ConnectionState.ONLINE) in seen)
        val types = seen.filterIsInstance<Update.Event>().map { it.event.type }
        assertEquals(listOf("hello", "info", "hello", "info"), types)
        assertEquals("H", c.hubId)
        assertEquals(6, c.seq)
        // Re-focused after hello.
        val rpcs = recorded.filter { it.first.path == "/api/rpc" }.map { opened(it.second) }
        assertTrue(rpcs.any { it["m"].string == "focus" && it["p"] == obj("client" to "c1", "agent" to "a1") })
        // The reconnect resumed from what the first stream delivered.
        val streams = recorded.filter { it.first.path!!.startsWith("/api/stream") }.map { Envelope.open(key, it.first.requestUrl!!.queryParameter("b")!!) }
        assertEquals(obj("t" to streams[1]["t"], "since" to 6, "hub" to "H", "focus" to "a1"), streams[1])
    }

    @Test fun updatesEndOnUnauthorized() = runBlocking {
        serve { _, _ -> MockResponse().setResponseCode(401) }
        val seen = mutableListOf<Update>()
        val e = failure { withTimeout(10_000) { HubClient(machine).updates().collect { seen.add(it) } } }
        assertSame(HubError.Unauthorized, e)
        assertEquals(listOf<Update>(Update.State(ConnectionState.CONNECTING)), seen)
    }

    @Test fun stallReconnects() = runBlocking {
        // A stream that sends a ping and then nothing: the stall watchdog must give up on it.
        serve { _, _ -> MockResponse().setBody(": ping\n\n: more\n\n").throttleBody(8, 2, TimeUnit.SECONDS) }
        val c = HubClient(machine)
        c.configure(backoffMinMs = 10, backoffMaxMs = 20, stallTimeoutMs = 300)
        val start = System.nanoTime()
        withTimeout(5_000) { c.updates().takeWhile { it != Update.State(ConnectionState.OFFLINE) }.toList() }
        assertTrue((System.nanoTime() - start) / 1_000_000 < 5_000)
    }
}
