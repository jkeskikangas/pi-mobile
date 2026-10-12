package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.min
import kotlin.math.sqrt

/**
 * plans/native-apps.md §7 Tests: VoiceEngine driven by FakeRealtime + FakeHub with the real
 * web/voice-core.js. Port of native/ios/PiTests/Voice/VoiceEngineTests.swift, scenario for scenario.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VoiceEngineTest {
    private val hub = FakeHub(listOf(FleetMachine("m1", "laptop"), FleetMachine("m2", "box")))
    private var rt = FakeRealtime()
    private val basic = FakeBasic()
    private val earcons = FakeEarcons()
    private val clock = ManualScheduler()
    private val prefs = MemoryPrefs()
    private val session = FakeAudioSession()
    private lateinit var engine: VoiceEngine

    init {
        hub.agents["m1"] = listOf(info("a1", "web"))
        hub.agents["m2"] = listOf(info("b1", "api"))
        hub.reply = { c ->
            when (c.m) {
                "voiceSession" -> obj("sdp" to "v=0 answer", "model" to "gpt-realtime", "provider" to "openai")
                "send" -> obj("delivered" to "prompt")
                "brief" -> obj("speech" to "Tests pass.", "more" to emptyList<String>(), "report" to "all good")
                else -> obj()
            }
        }
        prefs[VoiceEngine.INTRO_KEY] = "1"
    }

    /** Each test runs with the engine on the test dispatcher (`backgroundScope`, cancelled at the end). */
    private fun voiceTest(body: suspend TestScope.() -> Unit) = runTest {
        engine = VoiceEngine(
            backgroundScope,
            VoiceDeps(
                fleet = hub, core = core,
                makeRealtime = { rt }, makeBasic = { basic },
                earcons = earcons, audioSession = session, prefs = prefs, scheduler = clock,
                now = { clock.now }, ms = { clock.t * 1000 },
            ),
        )
        body()
    }

    /** Lets queued engine work (launched coroutines, stream deliveries) run. */
    private fun TestScope.settle() = runCurrent()

    private suspend fun TestScope.open() {
        engine.start("a1", "m1")
        settle()
    }

    // region scenarios

    @Test fun startsRealtimeThroughTheSessionsMachine() = voiceTest {
        open()
        assertEquals(VoiceEngineKind.REALTIME, engine.engineKind)
        assertEquals(VoiceState.LISTENING, engine.state)
        assertEquals("m1", hub.calls("voiceSession").first().machine)
        assertEquals(JsonPrimitive("v=0 offer"), hub.calls("voiceSession").first().p["sdp"])
        assertTrue(rt.injected.first().startsWith("[PI] Voice mode started."))
        assertEquals(JsonPrimitive(true), hub.calls("voiceState").last().p["on"])
    }

    @Test fun twoMachines() = voiceTest {
        open()
        // Switching to a session on the other machine keeps the call.
        val out = engine.tool("switch_session", obj("name" to "api"))
        assertEquals("api on box", out["switched"].string)
        assertEquals("m2", engine.machineId)
        assertEquals("b1", engine.agent)
        assertFalse(rt.closed)
        assertEquals(VoiceEngineKind.REALTIME, engine.engineKind)
        // Session calls go to the session's machine, speech calls to the speech machine.
        engine.tool("ask_pi", obj("request" to "run the tests"))
        assertEquals("m2", hub.calls("send").last().machine)
        engine.speechCall("voices", obj())
        assertEquals("m1", hub.calls("voices").last().machine)
        // Its machine going down is announced once.
        rt.clear()
        hub.state("m2", ConnectionState.OFFLINE)
        hub.state("m2", ConnectionState.OFFLINE)
        settle()
        assertEquals(1, rt.injected.count { "went offline" in it })
        assertEquals(1, earcons.played.count { it == "failed" })
        hub.state("m2", ConnectionState.ONLINE)
        settle()
        assertEquals(1, rt.injected.count { "is reachable again" in it })
    }

    @Test fun questionGoesToPiAndBriefComesBack() = voiceTest {
        open()
        rt.emit(obj("type" to "input_audio_buffer.speech_started"))
        assertEquals(VoiceState.HEARING, engine.state)
        clock.advance(2.0)
        rt.emit(obj("type" to "input_audio_buffer.speech_stopped"))
        assertEquals(VoiceState.THINKING, engine.state)
        rt.emit(obj("type" to "conversation.item.input_audio_transcription.completed", "transcript" to "Run the tests and tell me what fails"))
        assertEquals("Run the tests and tell me what fails", engine.heard.text)
        rt.emit(obj("type" to "response.created"))
        rt.emit(obj("type" to "response.function_call_arguments.done", "name" to "ask_pi", "call_id" to "c1", "arguments" to """{"request":"Run the tests and tell me what fails"}"""))
        assertEquals("output_audio_buffer.clear", rt.types.last())
        settle()
        assertEquals("Run the tests and tell me what fails", hub.calls("send").first().p["text"].string)
        assertEquals("steer", hub.calls("send").first().p["mode"].string)
        assertTrue(rt.sent.any { it["item"]["type"].string == "function_call_output" && it["item"]["call_id"].string == "c1" })
        assertEquals(VoiceState.WORKING, engine.state)
        rt.emit(obj("type" to "response.done"))
        rt.clear()
        hub.event("m1", obj("type" to "info", "agent" to "a1", "info" to info("a1", "web", status = "working")))
        settle()
        hub.event("m1", obj("type" to "info", "agent" to "a1", "info" to info("a1", "web", status = "idle")))
        settle()
        assertEquals("m1", hub.calls("brief").first().machine)
        assertTrue(rt.injected.any { it.startsWith("[PI] pi finished.") && "SPOKEN BRIEF: Tests pass." in it })
        assertEquals("response.create", rt.types.last())
        assertTrue("done" in earcons.played)
    }

    /** pi speaking with the mic at [level] for [seconds] (20 ms VAD frames). */
    private fun speakingWithMic(level: Double, seconds: Double) {
        rt.micRaw = level
        rt.micLevel = min(1.0, sqrt(level) * 1.6)
        clock.advance(seconds)
    }

    private fun startSpeaking() {
        rt.emit(obj("type" to "response.created"))
        rt.emit(obj("type" to "output_audio_buffer.started"))
        assertEquals(VoiceState.SPEAKING, engine.state)
        assertTrue(rt.sent.any { it["type"].string == "session.update" && it["session"]["audio"]["input"]["turn_detection"] == JsonNull })
    }

    @Test fun backchannelWhileSpeakingDucksButNeverCancels() = voiceTest {
        open()
        rt.emit(obj("type" to "session.updated", "session" to obj("audio" to obj("input" to obj("turn_detection" to obj("type" to "semantic_vad"))))))
        startSpeaking()
        speakingWithMic(0.2, 0.3)
        assertEquals("ducked at the first sound", 0.2, rt.remoteVolume, 0.0)
        speakingWithMic(0.0, 1.0)
        assertEquals("input_audio_buffer.commit", rt.types.last())
        assertEquals(VoiceState.SPEAKING, engine.state)
        rt.emit(obj("type" to "conversation.item.input_audio_transcription.completed", "transcript" to "mm-hmm"))
        assertEquals("unducked", 1.0, rt.remoteVolume, 0.0)
        assertEquals(VoiceState.SPEAKING, engine.state)
        assertFalse("response.cancel" in rt.types)
        assertFalse("output_audio_buffer.clear" in rt.types)
        // pi finishes: server turn detection comes back.
        rt.emit(obj("type" to "output_audio_buffer.stopped"))
        assertEquals("semantic_vad", rt.sent.last()["session"]["audio"]["input"]["turn_detection"]["type"].string)
    }

    @Test fun interruptionAfterBargeTime() = voiceTest {
        open()
        startSpeaking()
        speakingWithMic(0.2, 0.5)
        assertEquals(0.2, rt.remoteVolume, 0.0)
        assertFalse("response.cancel" in rt.types)
        speakingWithMic(0.2, 0.6)
        assertTrue("response.cancel" in rt.types)
        assertTrue("output_audio_buffer.clear" in rt.types)
        assertEquals(VoiceState.HEARING, engine.state)
        rt.emit(obj("type" to "response.done"))
        rt.clear()
        speakingWithMic(0.0, 1.0)
        assertEquals(listOf("input_audio_buffer.commit", "response.create"), rt.types)
        assertEquals(VoiceState.THINKING, engine.state)
    }

    private fun deployPrompt() = obj("id" to "p1", "kind" to "confirm", "title" to "Deploy to production?", "message" to "This ships main.")

    private fun say(text: String) {
        rt.emit(obj("type" to "input_audio_buffer.speech_started"))
        clock.advance(2.0)
        rt.emit(obj("type" to "input_audio_buffer.speech_stopped"))
        rt.emit(obj("type" to "conversation.item.input_audio_transcription.completed", "transcript" to text))
    }

    @Test fun destructivePromptNamedEarlierGoesAheadAfterGrace() = voiceTest {
        open()
        say("deploy the app to production")
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to deployPrompt()))
        settle()
        assertNotNull(engine.question?.grace)
        assertTrue(rt.injected.any { "the phone confirms it in 4 seconds" in it })
        clock.advance(3.9)
        settle()
        assertTrue(hub.calls("answer").isEmpty())
        clock.advance(0.2)
        settle()
        assertEquals(json("id" to "p1", "value" to true), hub.calls("answer").first().p)
    }

    @Test fun stopWithinGraceAnswersNo() = voiceTest {
        open()
        say("deploy the app to production")
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to deployPrompt()))
        settle()
        clock.advance(1.0)
        say("stop")
        settle()
        assertEquals(json("id" to "p1", "value" to false), hub.calls("answer").first().p)
        assertNull(engine.question?.grace)
        clock.advance(5.0)
        settle()
        assertEquals(1, hub.calls("answer").size)
        assertTrue("stop cancels the confirmation, not pi's work", hub.calls("abort").isEmpty())
    }

    @Test fun bareYeahToDestructivePromptIsRefused() = voiceTest {
        open()
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to deployPrompt()))
        settle()
        assertEquals(VoiceState.ASKING, engine.state)
        assertNull(engine.question?.grace)
        val out = engine.tool("answer_question", obj("id" to "p1", "answer" to "yeah"))
        assertTrue(out["error"].string.orEmpty().contains("yes, deploy"))
        assertTrue(hub.calls("answer").isEmpty())
        val ok = engine.tool("answer_question", obj("id" to "p1", "answer" to "yes, deploy"))
        assertEquals(JsonPrimitive(true), ok["answered"])
    }

    @Test fun echoOfPisWordsNeverCounts() = voiceTest {
        open()
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to deployPrompt()))
        settle()
        startSpeaking()
        rt.emit(obj("type" to "response.output_audio_transcript.done", "transcript" to "Deploy to production? Say yes, deploy to confirm, or no."))
        // The mic picks pi's own voice up over the speaker.
        speakingWithMic(0.2, 0.3)
        speakingWithMic(0.0, 1.0)
        rt.emit(obj("type" to "conversation.item.input_audio_transcription.completed", "transcript" to "yes, deploy to confirm"))
        assertEquals("echo is not a turn", VoiceState.SPEAKING, engine.state)
        val out = engine.tool("answer_question", obj("id" to "p1", "answer" to "yes, deploy"))
        assertTrue(out["error"].string.orEmpty().contains("your own voice"))
        assertTrue(hub.calls("answer").isEmpty())
        // And it never counts as an earlier request for the undo window.
        assertFalse(engine.namedEarlier(deployPrompt()))
    }

    @Test fun realtimeUnavailableFallsBackToBasicVoice() = voiceTest {
        hub.reply = { c ->
            if (c.m == "voiceSession") throw HubError.Remote("realtime unavailable: no OpenAI sign-in on this computer")
            obj()
        }
        open()
        assertEquals(VoiceEngineKind.BASIC, engine.engineKind)
        assertTrue(basic.started)
        assertEquals("Using basic voice. Details in voice settings.", engine.note)
        assertEquals("no OpenAI sign-in on this computer", engine.settings.basicReason)
        // Both machines were tried for speech before giving up.
        assertEquals(setOf("m1", "m2"), hub.calls("voiceSession").map { it.machine }.toSet())
        clock.advance(8.1)
        assertEquals("", engine.note)
    }

    @Test fun spokenSettingChangesItAndPersists() = voiceTest {
        open()
        say("push to talk")
        rt.emit(obj("type" to "response.done"))
        assertEquals(VoiceTurns.TAP, engine.settings.turns)
        assertEquals("tap", prefs[VoiceEngine.TURN_KEY])
        assertEquals(VoiceState.PAUSED, engine.state)
        assertEquals("Push to talk", engine.label)
        assertFalse(rt.micEnabled)
        // Hold to talk.
        assertTrue(engine.pressStart())
        assertTrue(rt.micEnabled)
        assertEquals(VoiceState.HEARING, engine.state)
        rt.clear()
        engine.pressEnd(held = true)
        assertEquals(listOf("input_audio_buffer.commit", "response.create"), rt.types)
        assertEquals(VoiceState.THINKING, engine.state)
    }

    @Test fun stopClosesAndReportsVoiceStateOff() = voiceTest {
        open()
        var closed = false
        engine.onClose = { closed = true }
        engine.stop()
        settle()
        assertTrue(closed)
        assertTrue(rt.closed)
        assertFalse(engine.isOpen)
        assertEquals(JsonPrimitive(false), hub.calls("voiceState").last().p["on"])
        assertEquals("off", earcons.played.last())
        // The "off" earcon plays out before the session is released.
        assertEquals(0, session.deactivations)
        clock.advance(0.4)
        assertEquals(1, session.deactivations)
        assertEquals(1, earcons.stopped)
    }

    // endregion

    // region review regressions

    @Test fun hubTooOldForVoiceIsRefusedClearly() = voiceTest {
        hub.features["m1"] = listOf("voice", "speak")
        open()
        assertNull(engine.engineKind)
        assertTrue("newer pi-mobile on laptop" in engine.note)
        assertTrue(hub.calls("voiceSession").isEmpty())
        assertEquals("failed", earcons.played.last())
    }

    private fun machine(id: String, name: String) = Machine(id = id, name = name, origin = "http://$name", d = "d", k = "k")

    @Test fun machineListChangesReachTheRunningVoiceMode() = voiceTest {
        open()
        assertEquals(setOf("m1", "m2"), engine.sessions.map { it.machine }.toSet())
        // Removed: its sessions vanish.
        engine.machinesChanged(listOf(machine("m1", "laptop")))
        assertEquals(listOf("m1"), engine.sessions.map { it.machine })
        // Added: loaded while voice runs.
        hub.agents["m3"] = listOf(info("c1", "docs"))
        engine.machinesChanged(listOf(machine("m1", "laptop"), machine("m3", "studio")))
        settle()
        assertTrue(engine.sessions.any { it.machine == "m3" && it.name == "docs" })
        assertTrue(engine.isOpen)
        // The followed session's machine removed: voice mode ends.
        engine.machinesChanged(listOf(machine("m3", "studio")))
        assertFalse(engine.isOpen)
    }

    @Test fun lateReleaseNeverCutsDictationsSession() = voiceTest {
        open()
        engine.stop()
        AudioOwner.claim() // dictation starts within the release delay
        clock.advance(0.4)
        assertEquals(0, session.deactivations)
        assertEquals(1, earcons.stopped)
    }

    @Test fun endDuringPersonaRedialStartsNothing() = voiceTest {
        open()
        // The redial's voiceSession hangs, then fails after End.
        hub.hold = mutableSetOf("voiceSession")
        hub.reply = { c ->
            if (c.m == "voiceSession") throw HubError.Remote("realtime unavailable: off")
            obj()
        }
        rt = FakeRealtime()
        val t = launch { engine.setPersona("cedar") }
        settle()
        assertEquals(VoiceState.CONNECTING, engine.state)
        engine.stop()
        hub.release("voiceSession")
        t.join()
        settle()
        assertNull(engine.engineKind)
        assertFalse("no basic-voice mic after End", basic.started)
        assertTrue(basic.spoken.isEmpty())
        assertFalse(engine.isOpen)
    }

    @Test fun cardAnswerIsCheckedAgainstTheShownQuestion() = voiceTest {
        open()
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to obj("id" to "q1", "kind" to "confirm", "title" to "Run the tests?")))
        settle()
        hub.event("m1", obj("type" to "prompt_end", "agent" to "a1", "id" to "q1", "by" to "terminal"))
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to obj("id" to "q2", "kind" to "confirm", "title" to "Delete the cache?")))
        settle()
        val yes = VoiceQuestion.Option("Yes", JsonPrimitive(true), false)
        val stale = engine.answer(yes, "q1")
        assertFalse(stale)
        assertTrue("a tap on the old card never answers the new question", hub.calls("answer").isEmpty())
        val ok = engine.answer(yes, "q2")
        assertTrue(ok)
        assertEquals(json("id" to "q2", "value" to true), hub.calls("answer").last().p)
    }

    private fun TestScope.startGraceForDeploy(id: String = "p1") {
        say("deploy the app to production")
        rt.emit(obj("type" to "response.done"))
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to obj("id" to id, "kind" to "confirm", "title" to "Deploy to production?")))
        settle()
        assertEquals(id, engine.grace?.prompt?.get("id").string)
    }

    @Test fun graceReplacementAnswersEachWindowOnce() = voiceTest {
        open()
        startGraceForDeploy("p1")
        clock.advance(2.0)
        hub.event("m1", obj("type" to "prompt_end", "agent" to "a1", "id" to "p1", "by" to "remote"))
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to obj("id" to "p2", "kind" to "confirm", "title" to "Deploy to production?")))
        settle()
        assertEquals("p2", engine.grace?.prompt?.get("id").string)
        // p1's old timer must not fire for p2.
        clock.advance(2.5)
        settle()
        assertTrue(hub.calls("answer").isEmpty())
        clock.advance(2.0)
        settle()
        assertEquals(listOf(json("id" to "p2", "value" to true)), hub.calls("answer").map { it.p })
        // A replacement while a window is open cancels the old one (answered no) synchronously.
        startGraceForDeploy("p3")
        engine.startGrace(obj("id" to "p4", "kind" to "confirm", "title" to "Deploy to production?"))
        settle()
        assertEquals(json("id" to "p3", "value" to false), hub.calls("answer").last().p)
        assertEquals("p4", engine.grace?.prompt?.get("id").string)
    }

    @Test fun interruptionDropsGraceAndResumes() = voiceTest {
        open()
        startGraceForDeploy()
        session.onInterruption?.invoke(true)
        assertNull(engine.grace)
        assertEquals(VoiceState.PAUSED, engine.state)
        assertFalse(rt.micEnabled)
        clock.advance(5.0)
        settle()
        assertTrue("no approval while nobody can say stop", hub.calls("answer").isEmpty())
        // Ended without permission to resume, and the session can't come back yet: stay paused.
        session.onInterruption?.invoke(null)
        session.failActivate = true
        engine.tap()
        assertEquals(VoiceState.PAUSED, engine.state)
        assertFalse(rt.micEnabled)
        session.failActivate = false
        engine.tap()
        assertEquals(VoiceState.LISTENING, engine.state)
        assertTrue(rt.micEnabled)
        // Allowed to resume: resumes by itself.
        session.onInterruption?.invoke(true)
        session.onInterruption?.invoke(false)
        assertEquals(VoiceState.LISTENING, engine.state)
    }

    @Test fun aNewSessionStartsUnmutedAndEndingClearsTheMute() = voiceTest {
        // (b) a mute left on app-wide doesn't carry into a new session.
        session.systemMuted = true
        open()
        assertFalse(engine.muted)
        assertFalse(session.isInputMuted)
        assertTrue(rt.micEnabled)
        // (a) ending a muted session clears the app-wide mute.
        engine.toggleMute()
        assertTrue(session.isInputMuted)
        engine.stop()
        assertFalse(session.isInputMuted)
        assertFalse(engine.muted)
    }

    @Test fun systemMuteDuringASessionAndMuteDropsGrace() = voiceTest {
        open()
        session.onInputMute?.invoke(true)
        assertTrue(engine.muted)
        assertEquals(VoiceState.PAUSED, engine.state)
        assertFalse(rt.micEnabled)
        session.onInputMute?.invoke(false)
        assertFalse(engine.muted)
        assertTrue(rt.micEnabled)
        startGraceForDeploy()
        engine.toggleMute()
        assertNull(engine.grace)
        assertTrue(session.isInputMuted)
        clock.advance(5.0)
        settle()
        assertTrue(hub.calls("answer").isEmpty())
    }

    @Test fun restartForgetsEarlierRequests() = voiceTest {
        open()
        say("deploy the app to production")
        engine.stop()
        settle()
        open()
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to deployPrompt()))
        settle()
        assertNull("consent from an earlier voice mode never carries over", engine.grace)
        assertEquals(VoiceState.ASKING, engine.state)
    }

    @Test fun oldRequestsExpire() = voiceTest {
        open()
        say("deploy the app to production")
        clock.advance(181.0)
        assertFalse(engine.namedEarlier(deployPrompt()))
    }

    @Test fun nothingIsSentAfterEnd() = voiceTest {
        hub.reply = { c ->
            if (c.m == "voiceSession") throw HubError.Remote("realtime unavailable: off")
            obj("delivered" to "prompt")
        }
        open()
        assertEquals(VoiceEngineKind.BASIC, engine.engineKind)
        hub.hold = mutableSetOf("distill")
        val t = launch { engine.handleUtterance("please run the whole test suite") }
        settle()
        assertEquals("distill goes to the followed session", "m1", hub.calls("distill").first().machine)
        engine.stop()
        hub.release("distill")
        t.join()
        settle()
        assertTrue(hub.calls("send").isEmpty())
        assertTrue(basic.spoken.isEmpty())
    }

    @Test fun clientVadUsesRawLevelNotDisplayLevel() = voiceTest {
        open()
        startSpeaking()
        // Display level looks loud (sqrt-scaled) but the raw RMS is below the over-pi threshold.
        rt.micRaw = 0.02
        rt.micLevel = 0.23
        clock.advance(1.0)
        assertEquals(1.0, rt.remoteVolume, 0.0)
        assertFalse("input_audio_buffer.commit" in rt.types)
    }

    @Test fun deadSpeechMachineIsRepickedOnce() = voiceTest {
        open()
        engine.tool("switch_session", obj("name" to "api"))
        hub.reply = { c ->
            if (c.machine == "m1") throw HubError.Network("Can't reach laptop.")
            obj("personas" to emptyList<Any>())
        }
        val before = hub.calls("voices").size
        engine.speechCall("voices", obj())
        assertEquals(listOf("m1", "m2"), hub.calls("voices").drop(before).map { it.machine })
        assertEquals("m2", engine.speechMachine)
        assertEquals("the call stays up", VoiceEngineKind.REALTIME, engine.engineKind)
    }

    @Test fun headsetPlayPauseActsLikeATap() = voiceTest {
        open()
        startSpeaking()
        rt.clear()
        session.onRemoteToggle?.invoke()
        assertEquals(listOf("response.cancel", "output_audio_buffer.clear"), rt.types)
        assertEquals(VoiceState.LISTENING, engine.state)
        rt.emit(obj("type" to "response.done"))
        hub.event("m1", obj("type" to "prompt", "agent" to "a1", "prompt" to obj("id" to "q", "kind" to "confirm", "title" to "Run the tests?")))
        settle()
        rt.emit(obj("type" to "response.done"))
        rt.clear()
        engine.answer(VoiceQuestion.Option("Yes", JsonPrimitive(true), false))
        settle()
        assertEquals(json("id" to "q", "value" to true), hub.calls("answer").last().p)
        assertFalse("cancel only while a response is active", "response.cancel" in rt.types)
    }

    // endregion

    companion object {
        private val core = repoVoiceCore()

        @JvmStatic @AfterClass fun closeCore() = core.close()

        fun info(agent: String, name: String, status: String = "idle"): JsonElement =
            obj("agent" to agent, "name" to name, "cwd" to "/src/$name", "status" to status)
    }
}
