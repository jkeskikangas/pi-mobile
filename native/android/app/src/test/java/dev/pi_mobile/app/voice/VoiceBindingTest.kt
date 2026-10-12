package dev.pi_mobile.app.voice

import dev.pi_mobile.app.voiceui.EngineVoiceActions
import dev.pi_mobile.app.voiceui.VoiceScreenModel
import dev.pi_mobile.app.voiceui.toScreenModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import dev.pi_mobile.app.voiceui.VoiceAttention as UiAttention
import dev.pi_mobile.app.voiceui.VoiceEngineKind as UiKind
import dev.pi_mobile.app.voiceui.VoiceQuestion as UiQuestion
import dev.pi_mobile.app.voiceui.VoiceState as UiState
import dev.pi_mobile.app.voiceui.VoiceTurns as UiTurns

/** The engine's state as the voice screen's model, and the screen's intents back on the engine. */
@OptIn(ExperimentalCoroutinesApi::class)
class VoiceBindingTest {
    private val grace = VoiceQuestion.Grace(untilMs = 5_000, totalSeconds = 4.0)
    private val question = VoiceQuestion(
        "q", "confirm", "Deploy to production", "This ships main.", true,
        listOf(VoiceQuestion.Option("Yes, do it", JsonPrimitive(true), true), VoiceQuestion.Option("No", JsonPrimitive(false), false)),
        grace,
    )
    private val ui = VoiceUiState(
        isOpen = true, state = VoiceState.ASKING, engineKind = VoiceEngineKind.BASIC,
        heard = VoiceCaption("deploy it"), said = VoiceCaption("Going ahead", live = true), note = "Using basic voice.",
        question = question, muted = true, talking = true, holding = true, agent = "a1", machineId = "m1",
        sessionName = "web", machineName = "laptop", sessionLine = "Needs you · Deploy", sessionStatus = "waiting",
        settings = VoiceSettings(
            VoiceAttention.GLANCE, VoiceTurns.TAP, "cedar",
            listOf(VoicePersona("cedar", "Cedar", "Warm", 1.1, listOf("Daniel"), 0.9)), "no sign-in",
        ),
        sessions = listOf(VoiceSessionItem("a1", "m1", "web", "laptop", "waiting", 1)),
    )

    @Test fun everyFieldMapsOneForOne() {
        val m: VoiceScreenModel = ui.toScreenModel()
        assertEquals(UiState.ASKING, m.state)
        assertEquals(ui.label, m.label)
        assertEquals(ui.hint, m.hint)
        assertEquals(ui.stageAction, m.stageAction)
        assertEquals(UiKind.BASIC, m.engineKind)
        assertEquals("deploy it", m.heard.text)
        assertTrue(m.said.live)
        assertEquals("Using basic voice.", m.note)
        assertEquals(listOf(true, true, true), listOf(m.muted, m.talking, m.holding))
        assertEquals(listOf("a1", "m1", "web", "laptop", "Needs you · Deploy", "waiting"), listOf(m.agent, m.machineId, m.sessionName, m.machineName, m.sessionLine, m.sessionStatus))
        val q = m.question!!
        assertEquals(listOf("q", "confirm", "Deploy to production", "This ships main."), listOf(q.id, q.kind, q.title, q.message))
        assertTrue(q.destructive)
        assertEquals(listOf(UiQuestion.Option("Yes, do it", JsonPrimitive(true), true), UiQuestion.Option("No", JsonPrimitive(false), false)), q.options)
        assertEquals(UiQuestion.Grace(5_000, 4_000), q.grace)
        assertEquals(1, q.grace!!.secondsLeft(4_100))
        assertEquals(UiAttention.GLANCE, m.settings.attention)
        assertEquals(UiTurns.TAP, m.settings.turns)
        assertEquals("cedar", m.settings.persona)
        assertEquals(listOf("cedar" to "Cedar"), m.settings.personas.map { it.id to it.name })
        assertEquals("no sign-in", m.settings.basicReason)
        assertEquals(listOf("web" to 1), m.sessions.map { it.name to it.waiting })
    }

    @Test fun aClosedEngineMapsToTheDefaults() {
        val m = VoiceUiState().toScreenModel()
        assertEquals(UiState.CONNECTING, m.state)
        assertEquals("Connecting…", m.label)
        assertEquals("Retry the microphone", m.stageAction)
        assertEquals(null, m.question)
        assertEquals(null, m.engineKind)
    }

    @Test fun actionsReachTheEngine() = runTest {
        val engine = VoiceEngine(backgroundScope)
        var revoked = 0
        val actions = EngineVoiceActions(engine, revokeConsent = { revoked++ })
        engine.start("a1", "m1") // no parts attached: opens for the preview path only
        assertTrue(engine.isOpen)
        assertFalse(actions.pressStart()) // open mic: no turn to start
        actions.revokeConsent()
        assertEquals(1, revoked)
    }
}
