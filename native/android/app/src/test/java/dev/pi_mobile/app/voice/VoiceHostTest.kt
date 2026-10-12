package dev.pi_mobile.app.voice

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.HubInfo
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.obj
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** VoiceHost: which session, the gates in order, idempotence, the removal check. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VoiceHostTest {
    private val prefs = Prefs(ApplicationProvider.getApplicationContext<Context>()).apply {
        setVoice(VoiceEngine.INTRO_KEY, "1")
        lastFocus = null
    }
    private val machines = mutableListOf(machine("m1", "laptop"), machine("m2", "box"))
    private val sessions = mutableMapOf(
        "m1" to listOf(session("a1", "web"), session("a2", "docs", "working")),
        "m2" to listOf(session("b1", "api")),
    )
    private val calls = mutableListOf<String>()
    private val consents = mutableListOf<String>()
    private val forgotten = mutableListOf<String>()
    private var consentRefused = false
    private var drained = 0
    private var unauthorized = false
    private val platform = FakePlatform()

    private fun machine(id: String, name: String) = Machine(id = id, name = name, origin = "https://$name", d = "d", k = "k")
    private fun session(agent: String, name: String, status: String = "idle") = obj("agent" to agent, "name" to name, "status" to status)

    private inner class Client(private val machine: Machine) : FleetClient {
        override suspend fun rpc(m: String, p: JsonObject): JsonElement =
            if (m == "hub") hubReply() else obj().also { calls.add("${machine.id}:$m") }
        override suspend fun agent(agent: String, m: String, p: JsonObject): JsonElement {
            calls.add("${machine.id}/$agent:$m")
            return when (m) {
                "voiceSession" -> obj("sdp" to "v=0 answer")
                "snapshot" -> obj("prompts" to emptyList<Any>())
                else -> obj()
            }
        }
        override suspend fun hub(): HubInfo {
            if (unauthorized) throw HubError.Unauthorized
            return HubInfo(hubReply())
        }
        override suspend fun focus(agent: String) {}
        override fun updates(): Flow<FleetClient.Update> = emptyFlow()
        private fun hubReply() = obj("agents" to sessions[machine.id].orEmpty(), "protocol" to 1, "features" to VoiceEngine.NEEDED_FEATURES)
    }

    private inner class FakePlatform : VoiceHost.Platform {
        override var micAllowed = true
        var services = 0
        val rt = FakeRealtime()
        override fun core() = core
        override fun realtime() = rt
        override fun basic() = FakeBasic()
        override fun earcons(core: VoiceCore) = FakeEarcons()
        override fun audioSession() = FakeAudioSession()
        override fun startService() {
            services += 1
        }
    }

    private lateinit var host: VoiceHost

    private fun hostTest(body: suspend TestScope.() -> Unit) = runTest {
        host = VoiceHost(
            backgroundScope, prefs, { machines.toList() }, ::Client, platform,
            consent = { kind -> consents.add(kind); if (consentRefused) throw HubError.Network("Allow voice mode first.") },
            drainDictation = { drained += 1 },
            forget = { forgotten.add(it.id) },
            scheduler = ManualScheduler(),
        )
        body()
    }

    private suspend fun TestScope.failure(block: suspend () -> Unit): Throwable? =
        try { block(); null } catch (e: Exception) { e }.also { runCurrent() }

    @Test fun pickPrefersNeedsYouThenLastUsed() {
        val a = VoiceHost.Target("a", "m", "A")
        val b = VoiceHost.Target("b", "m", "B")
        val c = VoiceHost.Target("c", "n", "C")
        val saved = Prefs.Focus("a", "m", "A")
        assertEquals(b, VoiceHost.pick(listOf(a to 2, b to 0, c to 1), saved))
        assertEquals(a, VoiceHost.pick(listOf(a to 2, c to 1), saved))
        assertEquals(c, VoiceHost.pick(listOf(a to 2, c to 1), null))
        assertNull(VoiceHost.pick(emptyList(), null))
        assertEquals(listOf(0, 1, 2, 2), listOf("waiting", "working", "idle", null).map(VoiceHost::urgency))
    }

    @Test fun startsOnTheSessionThatNeedsYouAndRemembersIt() = hostTest {
        sessions["m2"] = listOf(session("b1", "api", "waiting"))
        host.start()
        runCurrent()
        assertEquals(1, drained)
        assertEquals(listOf("voice"), consents)
        assertEquals(1, platform.services)
        assertSame(host.engine, host.running.value)
        assertEquals("m2", host.engine.machineId)
        assertEquals("b1", host.engine.agent)
        assertEquals(VoiceEngineKind.REALTIME, host.engine.engineKind)
        assertEquals(Prefs.Focus("b1", "m2", "api"), prefs.lastFocus)
    }

    @Test fun withoutANeedThePickIsTheLastUsedThenTheBusiest() = hostTest {
        host.start()
        runCurrent()
        assertEquals("a2", host.engine.agent) // working beats idle
        host.end()
        runCurrent()
        assertNull(host.running.value)
        prefs.lastFocus = Prefs.Focus("b1", "m2", "api")
        host.start()
        runCurrent()
        assertEquals("b1", host.engine.agent)
    }

    @Test fun gatesComeBeforeAnyAudio() = hostTest {
        sessions.clear()
        assertEquals(VoiceHost.NO_SESSION, failure { host.start() }?.message)
        assertEquals(VoiceHost.NOT_PAIRED, failure { host.start("x", "gone") }?.message)
        consentRefused = true
        assertEquals("Allow voice mode first.", failure { host.start("a1", "m1") }?.message)
        consentRefused = false
        platform.micAllowed = false
        assertEquals(VoiceHost.MIC_OFF, failure { host.start("a1", "m1") }?.message)
        assertEquals(0, platform.services)
        assertFalse(host.engine.isOpen)
        assertTrue(calls.none { it.endsWith(":voiceSession") })
        assertEquals(4, drained) // dictation is drained by every entry point, even a refused one
    }

    @Test fun aSecondStartFollowsTheNewSessionInTheSameCall() = hostTest {
        host.start("a1", "m1")
        runCurrent()
        host.start("b1", "m2")
        runCurrent()
        assertEquals(1, platform.services)
        assertEquals(listOf("voice", "voice"), consents) // every switch passes the gate too
        assertEquals("b1", host.engine.agent)
        assertEquals(1, calls.count { it.endsWith(":voiceSession") })
        assertFalse(platform.rt.closed)
    }

    @Test fun aRemovalIsForgottenOnlyWhenTheHubConfirmsIt() = hostTest {
        host.start("a1", "m1")
        runCurrent()
        val fleet = host.engine.deps!!.fleet as LiveFleet
        fleet.onUnauthorized!!("m2")
        runCurrent()
        assertEquals(emptyList<String>(), forgotten)
        unauthorized = true
        fleet.onUnauthorized!!("m2")
        runCurrent()
        assertEquals(listOf("m2"), forgotten)
    }

    @Test fun voicePrefsGoThroughTheBridgeKeys() {
        val p = PrefsVoicePrefs(prefs)
        p[VoiceEngine.TURN_KEY] = "tap"
        p["not-a-voice-key"] = "x"
        assertEquals("tap", prefs.voice(VoiceEngine.TURN_KEY))
        assertNull(p["not-a-voice-key"])
    }

    companion object {
        private val core = repoVoiceCore()

        @JvmStatic @AfterClass fun closeCore() = core.close()
    }
}
