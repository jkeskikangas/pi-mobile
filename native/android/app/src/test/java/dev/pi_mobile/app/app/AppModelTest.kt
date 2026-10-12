package dev.pi_mobile.app.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.Envelope
import dev.pi_mobile.app.core.InMemoryMachineStore
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.PairingLink
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.InetAddress

/** AppModel's rules for the page's list (BRIDGE.md `machines`, `unpaired`) beyond the bridge-level ports in BridgeTest. */
@RunWith(RobolectricTestRunner::class)
class AppModelTest {
    private val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private val origin = "http://127.0.0.1:${server.port}"
    private val otherOrigin = "http://localhost:${server.port}"
    private val key = Base64Url.encode(ByteArray(32) { 3 })
    private val store = InMemoryMachineStore()
    private val model = AppModel(store, Prefs(ApplicationProvider.getApplicationContext<Context>()), OkHttpClient())

    @After fun stop() = server.shutdown()

    private fun machine(id: String, primary: Boolean = false, origin: String = this.origin) =
        Machine(id = id, machine = "mx-$id", name = "Mac $id", origin = origin, d = "d-$id", k = key, primary = primary, added = 1.0)

    /** 401 (this phone was removed) from the computer at 127.0.0.1, 500 (reachable, still accepts it) from localhost. */
    private fun primaryRevokedOtherKept() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse().setResponseCode(if (request.getHeader("Host")!!.startsWith("127.0.0.1")) 401 else 500).setBody("{}")
        }
    }

    @Test fun thePagesPrimaryChoiceWins() = runBlocking {
        model.added(machine("a", primary = true))
        model.webMachines(listOf(machine("a"), machine("b", primary = true, origin = otherOrigin)))
        assertEquals("b", model.primary?.id)
        assertEquals(listOf(false, true), store.load().map { it.primary })
    }

    @Test fun aRevokedPrimaryGoesAndTheNextOneServes() = runBlocking {
        primaryRevokedOtherKept()
        model.added(machine("a", primary = true))
        model.added(machine("b", origin = otherOrigin))
        model.webMachines(listOf(machine("b", origin = otherOrigin)))
        assertEquals(listOf("b"), store.load().map { it.id })
        assertEquals("b", model.primary?.id)
        assertTrue(store.load().single().primary)
        assertEquals(emptyList<Machine>(), model.forgetQueue.value)
    }

    @Test fun unpairedKeepsWhatStillAcceptsThisPhoneUntilConfirmed() = runBlocking {
        primaryRevokedOtherKept()
        model.added(machine("a", primary = true))
        model.added(machine("b", origin = otherOrigin))
        model.webUnpaired()
        assertEquals(listOf("b"), model.machines.value.map { it.id })
        assertEquals(listOf("b"), model.forgetQueue.value.map { it.id })
        model.webUnpaired() // asked again: still one question
        assertEquals(1, model.forgetQueue.value.size)
        model.keep(model.forgetQueue.value.first())
        assertEquals(emptyList<Machine>(), model.forgetQueue.value)
        assertEquals(listOf("b"), store.load().map { it.id })
        model.forget(machine("b", origin = otherOrigin))
        assertNull("nothing left: the pairing screen", model.primary)
    }

    @Test fun malformedPageEntriesAreIgnored() {
        val good = machine("b", origin = otherOrigin).webEntry
        assertEquals(machine("b", origin = otherOrigin), Machine.fromWeb(good, origin))
        assertEquals(origin, Machine.fromWeb(machine("a", primary = true).webEntry, origin)?.origin)
        assertNull("short key", Machine.fromWeb(obj("id" to "x", "d" to "d", "k" to "abc", "origin" to otherOrigin), origin))
        assertNull("no id", Machine.fromWeb(obj("d" to "d", "k" to key, "origin" to otherOrigin), origin))
        assertNull("a secondary without an origin", Machine.fromWeb(obj("id" to "x", "d" to "d", "k" to key), origin))
    }

    @Test fun pairingNamesThisPhoneAndStoresThePrimary() = runBlocking {
        val pairKey = ByteArray(32) { 9 }
        var name: String? = null
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                name = Envelope.open(pairKey, parseJson(request.body.readUtf8())["b"].string!!)["name"].string
                val reply = obj("d" to "dev9", "k" to key, "host" to "Studio", "machine" to obj("id" to "mx-s"))
                return MockResponse().setBody(obj("b" to Envelope.seal(pairKey, reply)).encode())
            }
        }
        model.pair(PairingLink.parse("$origin/#p=pid.${Base64Url.encode(pairKey)}")!!)
        assertEquals("Android · pi app", name)
        assertEquals(listOf("Studio"), store.load().map { it.name })
        assertEquals("mx-s", model.primary?.machine)
    }

    @Test fun aPairingWhoseKeyCantBeSavedSaysWhatToDo() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse().setBody(obj("b" to Envelope.seal(ByteArray(32) { 9 }, obj("d" to "d", "k" to key, "host" to "S"))).encode())
        }
        store.failSaves = true
        val e = runCatching { model.pair(PairingLink.parse("$origin/#p=pid.${Base64Url.encode(ByteArray(32) { 9 })}")!!) }.exceptionOrNull()
        assertEquals("Paired, but this phone couldn't save the key. Run /remote again and scan the new code.", e?.message)
        assertNull(model.primary)
    }

    @Test fun oneClientPerComputerRebuiltWhenRePaired() {
        val a = machine("a", primary = true)
        val c = model.client(a)!!
        assertTrue(c === model.client(a))
        assertTrue(c !== model.client(a.copy(d = "d-new")))
        assertNull("plain HTTP is refused", model.client(machine("x", origin = "http://192.168.1.5:7000")))
    }
}
