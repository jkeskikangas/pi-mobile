package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.Envelope
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import java.net.InetAddress

/** The app's HubClient as voice's FleetClient, against MockWebServer: calls, events and a removed phone. */
class HubFleetClientTest {
    private val key = ByteArray(32) { (it + 3).toByte() }
    private val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private val machine = Machine(id = "m1", name = "Laptop", origin = server.url("/").toString().trimEnd('/'), d = "dev1", k = Base64Url.encode(key))
    private var streamStatus = 401

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path!!.startsWith("/api/stream")) return MockResponse().setResponseCode(streamStatus)
                val call = Envelope.open(key, parseJson(request.body.readUtf8())["b"].string!!)
                return MockResponse().setBody(obj("b" to Envelope.seal(key, obj("r" to obj("m" to call["m"], "p" to call["p"])))).encode())
            }
        }
    }

    @After fun stop() = server.shutdown()

    @Test fun callsGoThroughTheSealedClient() = runBlocking {
        val c = HubFleetClient(HubClient(machine))
        assertEquals(obj("m" to "hub", "p" to obj()), c.rpc("hub", obj()))
        val r = c.agent("a1", "send", obj("text" to "hi"))
        assertEquals(obj("agent" to "a1", "m" to "send", "p" to obj("text" to "hi")), r["p"])
    }

    @Test fun aRemovedPhoneEndsTheStreamAndLiveFleetSaysSo() = runBlocking {
        val c = HubFleetClient(HubClient(machine))
        val seenByClient = mutableListOf<FleetClient.Update>()
        val error = runCatching { withTimeout(10_000) { c.updates().collect { seenByClient.add(it) } } }.exceptionOrNull()
        assertSame(HubError.Unauthorized, error)
        assertEquals(listOf(FleetClient.Update.State(ConnectionState.CONNECTING)), seenByClient)

        val scope = CoroutineScope(Dispatchers.Default)
        val removed = java.util.concurrent.CopyOnWriteArrayList<String>()
        val fleet = LiveFleet(listOf(machine), scope) { HubFleetClient(HubClient(it)) }
        fleet.onUnauthorized = { removed.add(it) }
        val seen = withTimeout(10_000) { fleet.updates().take(2).toList() }
        assertEquals(listOf(FleetUpdate.State("m1", ConnectionState.CONNECTING), FleetUpdate.State("m1", ConnectionState.OFFLINE)), seen)
        withTimeout(10_000) { while (removed.isEmpty()) delay(10) } // the callback follows the OFFLINE it sent
        assertEquals(listOf("m1"), removed)
        scope.cancel()
    }
}
