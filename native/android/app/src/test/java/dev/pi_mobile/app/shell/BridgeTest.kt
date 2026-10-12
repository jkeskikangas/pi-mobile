package dev.pi_mobile.app.shell

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.app.AppModel
import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.InMemoryMachineStore
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.OriginPolicy
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.dictation.Dictation
import dev.pi_mobile.app.dictation.FakeRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
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
import java.util.Base64

/** Port of native/ios/PiTests/BridgeTests.swift: every BRIDGE.md message through [NativeBridge.handle]. */
@RunWith(RobolectricTestRunner::class)
class BridgeTest {
    private val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    private val origin = "http://127.0.0.1:${server.port}"
    /** The same server under another name: a second computer that is reachable. */
    private val otherOrigin = "http://localhost:${server.port}"
    private val store = InMemoryMachineStore()
    private val prefs = Prefs(ApplicationProvider.getApplicationContext<Context>())
    private val model = AppModel(store, prefs, OkHttpClient())
    private val recorder = FakeRecorder()
    private val dictation = Dictation(recorder, CoroutineScope(SupervisorJob() + Dispatchers.Unconfined))
    private val voice = FakeVoice()
    private val push = FakePush()
    private val consent = FakeConsent()
    private var scanner = scanning { "" }
    private val main = FrameInfo(isMainFrame = true, origin = origin)

    @After fun stop() = server.shutdown()

    private fun scanning(result: suspend () -> String) = object : Scanner {
        override suspend fun scan() = result()
    }

    private val bridge get() = NativeBridge(model, origin, dictation, voice, push, consent, scanner)

    private fun handle(vararg pairs: Pair<String, Any?>, frame: FrameInfo = main) = runBlocking { bridge.handle(obj(*pairs), frame) }

    private fun value(v: JsonElement = JsonNull) = Reply.Value(v)

    private fun machine(id: String, primary: Boolean = false, origin: String = this.origin) =
        Machine(id = id, machine = "mx-$id", name = "Mac $id", origin = origin, d = "d-$id", k = Base64Url.encode(ByteArray(32) { 3 }), primary = primary, added = 1.0, lastSeen = 2.0)

    /** Every hub request answers [status] (500: reachable but not saying 401, so the key stays). */
    private fun answer(status: Int, during: () -> Unit = {}) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                during()
                return MockResponse().setResponseCode(status).setBody("{}")
            }
        }
    }

    @Test fun onlyTheMainFrameOfThePairedOriginIsHeard() {
        assertEquals(Reply.Error("not allowed"), handle("type" to "consent.status", frame = FrameInfo(false, origin)))
        assertEquals(Reply.Error("not allowed"), handle("type" to "consent.status", frame = FrameInfo(true, "https://evil.example")))
        assertEquals(Reply.Error("not allowed"), handle("type" to "consent.status", frame = FrameInfo(true, origin.replace("http:", "https:"))))
        assertEquals(Reply.Error("not allowed"), handle("type" to "unpaired", frame = FrameInfo(true, "null")))
        assertEquals(value(obj("granted" to false)), handle("type" to "consent.status", frame = FrameInfo(true, "$origin/")))
        assertEquals(Reply.Error("unknown message"), handle("type" to "nope"))
    }

    @Test fun prefsAndVoiceStart() {
        assertEquals(value(), handle("type" to "prefs", "key" to "pi-mobile-voice-persona", "value" to "ash"))
        assertEquals(mapOf("pi-mobile-voice-persona" to "ash"), prefs.voicePrefs)
        handle("type" to "prefs", "key" to "something-else", "value" to "x")
        assertEquals(1, prefs.voicePrefs.size)
        assertEquals(Reply.Error("missing key"), handle("type" to "prefs"))

        assertEquals(Reply.Error("Open a session first."), handle("type" to "voice.start", "agent" to ""))
        assertEquals(value(), handle("type" to "voice.start", "agent" to "a", "machine" to "m"))
        model.added(machine("p", primary = true))
        handle("type" to "voice.start", "agent" to "b")
        assertEquals("the primary when the page names no machine", listOf("a" to "m", "b" to "p"), voice.started)
        voice.error = "Voice mode needs your OK to send your voice. Try again to see the details."
        assertEquals(Reply.Error(voice.error!!), handle("type" to "voice.start", "agent" to "a"))
        assertEquals(value(), handle("type" to "dictation.cancel"))
    }

    @Test fun voiceStartDiscardsDictationFirst() {
        handle("type" to "dictation.start")
        assertEquals(Dictation.State.RECORDING, dictation.state)
        val atStart = mutableListOf<Dictation.State>()
        voice.onStart = { atStart += dictation.state }
        handle("type" to "voice.start", "agent" to "a", "machine" to "m")
        assertEquals("the microphone is free when voice mode starts", listOf(Dictation.State.IDLE), atStart)
        assertEquals(1, recorder.cancels)
    }

    @Test fun dictationRepliesBase64Mp4() {
        assertEquals(value(), handle("type" to "dictation.start"))
        val audio = Base64.getEncoder().encodeToString(FakeRecorder.AUDIO)
        assertEquals(value(obj("audio" to audio, "mime" to "audio/mp4")), handle("type" to "dictation.stop"))
        assertEquals(Reply.Error("nothing is being recorded."), handle("type" to "dictation.stop"))
        assertEquals("idempotent", value(), handle("type" to "dictation.cancel"))
    }

    @Test fun machinesMessageAddsAndKeepsReachableOnes() {
        answer(500)
        model.added(machine("a", primary = true))
        val a = machine("a", primary = true).webEntry
        val b = machine("b", origin = otherOrigin).webEntry
        assertEquals(value(), handle("type" to "machines", "machines" to listOf(a, b)))
        assertEquals(listOf("a", "b"), model.machines.value.map { it.id })
        assertEquals("the primary is reached at the page origin", origin, model.machines.value[0].origin)
        handle("type" to "machines", "machines" to listOf(a))
        assertEquals("kept until confirmed", listOf("a", "b"), model.machines.value.map { it.id })
        assertEquals(listOf("b"), model.forgetQueue.value.map { it.id })
        model.forget(model.forgetQueue.value.first())
        assertEquals(listOf("a"), store.load().map { it.id })
        assertEquals(emptyList<Machine>(), model.forgetQueue.value)
    }

    @Test fun aPlainHttpComputerChangesNothing() {
        model.added(machine("a", primary = true))
        val lan = machine("b", origin = "http://192.168.1.20:7000").webEntry
        assertEquals(Reply.Error(OriginPolicy.PLAIN_HTTP_MESSAGE), handle("type" to "machines", "machines" to listOf(machine("a", true).webEntry, lan)))
        assertTrue(OriginPolicy.PLAIN_HTTP_MESSAGE.startsWith("This computer needs its secure address."))
        assertEquals(listOf("a"), store.load().map { it.id })
    }

    @Test fun unpairedRemovesRevokedComputers() {
        answer(401)
        model.added(machine("a", primary = true))
        assertEquals(value(), handle("type" to "unpaired"))
        assertNull(model.primary)
        assertEquals(emptyList<Machine>(), store.load())
    }

    @Test fun revocationCheckNeverDeletesARePairedCredential() {
        val old = machine("a", primary = true)
        model.added(old)
        // While the 401 check is in flight, the same entry is re-paired with a new key.
        answer(401) { model.added(old.copy(d = "d-new")) }
        runBlocking { model.webUnpaired() }
        assertEquals("d-new", model.primary?.d)
        assertEquals(listOf("d-new"), store.load().map { it.d })
        model.forget(old) // a stale confirmation must not delete the new key either
        assertEquals(listOf("d-new"), store.load().map { it.d })
    }

    @Test fun failedWritesAreReportedAndChangeNothing() {
        store.failSaves = true
        val r = handle("type" to "machines", "machines" to listOf(machine("a", primary = true).webEntry))
        assertEquals(Reply.Error("This phone couldn't save your computers. Try again."), r)
        assertEquals("nothing published that isn't stored", emptyList<Machine>(), model.machines.value)
    }

    @Test fun focusIsRememberedForStartVoice() {
        assertEquals(value(), handle("type" to "focus", "agent" to "ag1", "machine" to "m2", "name" to "infra"))
        assertEquals(Prefs.Focus("ag1", "m2", "infra"), prefs.lastFocus)
        model.added(machine("p", primary = true))
        handle("type" to "focus", "agent" to "ag2", "machine" to "", "name" to "")
        assertEquals(Prefs.Focus("ag2", "p", ""), prefs.lastFocus)
        handle("type" to "focus", "agent" to "")
        assertEquals("no session: nothing changes", "ag2", prefs.lastFocus?.agent)
    }

    @Test fun scanRepliesWithTheLinkOrCancelled() {
        val link = "http://box:7/#p=abc." + Base64Url.encode(ByteArray(32) { 1 })
        scanner = scanning { link }
        assertEquals(value(obj("link" to link)), handle("type" to "scan"))
        scanner = scanning { throw BridgeError("cancelled") }
        assertEquals("the web treats exactly this text as a silent cancel", Reply.Error("cancelled"), handle("type" to "scan"))
        scanner = scanning { throw BridgeError("busy") }
        assertEquals(Reply.Error("busy"), handle("type" to "scan"))
        scanner = scanning { throw BridgeError(ScanCenter.UNSUPPORTED) }
        assertEquals(Reply.Error("The camera isn't available on this phone. Paste the link instead."), handle("type" to "scan"))
    }

    @Test fun consentAndPushAreDelegated() {
        consent.ok = true
        assertEquals(value(obj("granted" to true)), handle("type" to "consent.status"))
        handle("type" to "dictation.start")
        assertEquals(value(obj("granted" to false)), handle("type" to "consent.revoke"))
        assertEquals(false, consent.ok)
        assertEquals("revoking drops a take", Dictation.State.IDLE, dictation.state)
        assertEquals("and ends voice mode", 1, voice.stops)

        assertEquals(value(FakePush.STATUS), handle("type" to "push.status"))
        assertEquals(value(FakePush.STATUS), handle("type" to "push.enable", "on" to false))
        handle("type" to "push.enable")
        assertEquals(listOf(false, true), push.enabled)
        push.error = "Notifications are off for pi. Turn them on in Settings."
        assertEquals(Reply.Error(push.error!!), handle("type" to "push.enable", "on" to true))
    }

    @Test fun makePrimaryStoresFirst() {
        model.added(machine("a", primary = true))
        model.added(machine("b", origin = otherOrigin))
        model.makePrimary(model.machines.value[1])
        assertEquals("b", model.primary?.id)
        assertEquals("b", store.load().first { it.primary }.id)
    }

    @Test fun pairingFailsWhenTheKeyCannotBeSaved() {
        store.failSaves = true
        assertTrue(runCatching { model.added(machine("a", primary = true)) }.isFailure)
        assertNull(model.primary)
    }

    @Test fun httpErrorPagesBecomeNativeMessages() {
        assertTrue(WebShell.httpMessage(404).contains("isn't pi"))
        assertTrue(WebShell.httpMessage(503).contains("HTTP 503"))
        assertEquals("Your computer didn't answer in time.", WebShell.errorMessage(android.webkit.WebViewClient.ERROR_TIMEOUT))
        assertEquals("Can't reach your computer.", WebShell.errorMessage(android.webkit.WebViewClient.ERROR_HOST_LOOKUP))
    }

    @Test fun repliesAreTheShimsJson() {
        assertEquals("""{"id":7,"ok":null}""", WebShell.replyJson(obj("n" to 7)["n"]!!, Reply.Value(JsonNull)))
        assertEquals("""{"id":7,"error":"busy"}""", WebShell.replyJson(obj("n" to 7)["n"]!!, Reply.Error("busy")))
    }

    @Test fun originRules() {
        assertEquals("https://mac.tail1.ts.net", NativeBridge.originRule("https://mac.tail1.ts.net/pi"))
        assertEquals("http://127.0.0.1:7995", NativeBridge.originRule("http://127.0.0.1:7995"))
        assertEquals("https://[::1]:8443", NativeBridge.originRule("https://[::1]:8443"))
        assertNull(NativeBridge.originRule("file:///x"))
        assertTrue(NativeBridge.sameOrigin("https://mac.ts.net:443/", "https://mac.ts.net/pi"))
    }
}

class FakeVoice : VoiceStarter {
    val started = mutableListOf<Pair<String, String>>()
    var onStart: () -> Unit = {}
    var stops = 0
    var error: String? = null

    override suspend fun start(agent: String, machine: String) {
        error?.let { throw BridgeError(it) }
        onStart()
        started += agent to machine
    }

    override fun stop() {
        stops += 1
    }
}

class FakePush : PushController {
    val enabled = mutableListOf<Boolean>()
    var error: String? = null
    override suspend fun status(): JsonElement = STATUS
    override suspend fun enable(on: Boolean): JsonElement {
        error?.let { throw BridgeError(it) }
        enabled += on
        return STATUS
    }

    companion object {
        val STATUS: JsonObject = obj("on" to false, "permission" to "default", "available" to true, "computers" to emptyList<Any>())
    }
}

class FakeConsent : ConsentController {
    var ok = false
    override suspend fun granted() = ok
    override suspend fun ensure(kind: ConsentKind) {
        if (!ok) throw BridgeError("needs your OK")
    }
    override fun revoke() {
        ok = false
    }
}
