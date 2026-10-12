package dev.pi_mobile.app.voiceui

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import dev.pi_mobile.app.ui.PiTheme
import kotlinx.serialization.json.JsonPrimitive

/** Voice screen states for previews and the screenshot tests (no audio, no hub); VoiceFixtures.swift. */
object VoiceFixtures {
    val personas = listOf(
        VoicePersona("marin", "Marin", "Warm and clear"),
        VoicePersona("cedar", "Cedar", "Calm, lower"),
        VoicePersona("sage", "Sage", "Brisk and bright"),
    )
    val sessions = listOf(
        VoiceSessionItem("a1", "m1", "pi-mobile", status = "working"),
        VoiceSessionItem("a2", "m1", "website", status = "idle", waiting = 1),
        VoiceSessionItem("a3", "m1", "infra", status = "idle"),
    )

    /** Every state the screenshots cover, by name. */
    val names = listOf("connecting", "listening", "hearing", "thinking", "working", "speaking", "asking", "select", "grace", "paused", "muted", "ptt", "offline")

    private val base = VoiceScreenModel(
        state = VoiceState.LISTENING,
        label = "Listening",
        stageAction = "Listening",
        engineKind = VoiceEngineKind.REALTIME,
        agent = "a1",
        machineId = "m1",
        sessionName = "pi-mobile",
        sessionLine = "Idle",
        sessionStatus = "idle",
        settings = VoiceSettings(personas = personas),
        sessions = sessions,
    )

    private val deleteBuild = VoiceQuestion(
        id = "q1", kind = "confirm", title = "Delete the old build folder?", message = "rm -rf native/android/app/build", destructive = true,
        options = listOf(
            VoiceQuestion.Option("Yes, do it", JsonPrimitive(true), destructive = true),
            VoiceQuestion.Option("No", JsonPrimitive(false)),
        ),
    )

    /** The screen in the named state; the undo window counts from [now]. */
    fun model(name: String, now: Long = System.currentTimeMillis()): VoiceScreenModel {
        val ptt = base.copy(settings = base.settings.copy(turns = VoiceTurns.TAP))
        return when (name) {
            "connecting" -> base.copy(state = VoiceState.CONNECTING, label = "Connecting…", stageAction = "Retry the microphone", engineKind = null)
            "listening" -> base.copy(hint = "Just talk — say “stop” any time")
            "hearing" -> base.copy(
                state = VoiceState.HEARING, label = "Listening…",
                heard = VoiceCaption("Is the build green and can you run the tests on the emulator", live = true),
            )
            "thinking" -> base.copy(state = VoiceState.THINKING, label = "Got it", heard = VoiceCaption("Is the build green?"))
            "working" -> base.copy(
                state = VoiceState.WORKING, label = "pi is on it", hint = "42s · ask “what's it doing?” any time",
                heard = VoiceCaption("Run the tests and tell me what fails."), said = VoiceCaption("On it. I'll run the tests now."),
                sessionLine = "Working · 0:42", sessionStatus = "working",
            )
            "speaking" -> base.copy(
                state = VoiceState.SPEAKING, label = "", hint = "Talk or tap to interrupt", stageAction = "Interrupt",
                heard = VoiceCaption("What's it doing?"),
                said = VoiceCaption("The tests pass. I changed the voice screen's header and the change is ready for you to review.", live = true),
            )
            "asking" -> base.copy(
                state = VoiceState.ASKING, label = "pi needs you", hint = "Answer out loud, or tap below",
                said = VoiceCaption("Delete the old build folder?"), question = deleteBuild,
                sessionLine = "Needs you · Delete the old build folder?", sessionStatus = "waiting",
            )
            "select" -> base.copy(
                state = VoiceState.ASKING, label = "pi needs you", hint = "Answer out loud, or tap below",
                question = VoiceQuestion(
                    id = "q2", kind = "select", title = "Which branch should I push to?",
                    options = listOf(
                        VoiceQuestion.Option("main", JsonPrimitive("main")),
                        VoiceQuestion.Option("voice-ui", JsonPrimitive("voice-ui")),
                        VoiceQuestion.Option("Force-push main", JsonPrimitive("Force-push main"), destructive = true),
                        VoiceQuestion.Option("Cancel", null, ghost = true),
                    ),
                ),
                sessionLine = "Needs you · Which branch?", sessionStatus = "waiting",
            )
            "grace" -> base.copy(
                state = VoiceState.ASKING, label = "pi needs you", hint = "Answer out loud, or tap below",
                question = deleteBuild.copy(message = null, options = emptyList(), grace = VoiceQuestion.Grace(now + 2_500, 5_000)),
                sessionLine = "Needs you", sessionStatus = "waiting",
            )
            "paused" -> ptt.copy(
                state = VoiceState.PAUSED, label = "Push to talk", hint = "Hold while you talk, or tap to start and stop", stageAction = "Talk",
            )
            "muted" -> base.copy(state = VoiceState.PAUSED, label = "Mic off", hint = "Tap to unmute", stageAction = "Unmute", muted = true)
            "ptt" -> ptt.copy(
                state = VoiceState.HEARING, label = "Listening…", hint = "Let go when you're done", stageAction = "Done talking",
                heard = VoiceCaption("Push the branch", live = true), talking = true, holding = true,
            )
            "offline" -> base.copy(state = VoiceState.OFFLINE, label = "Reconnecting…", note = "Lost the connection to your computer. Trying again…")
            else -> error("no voice fixture $name")
        }
    }

    /** The levels the orb shows in each fixture: your voice while you talk, pi's while it speaks. */
    fun levels(name: String) = VoiceLevels(mine = if (name == "hearing" || name == "ptt") 0.55f else 0.1f, pi = if (name == "speaking") 0.5f else 0f)

    /** Buttons that do nothing: previews and screenshots. */
    object NoActions : VoiceActions {
        override fun pressStart() = false
        override fun pressEnd(held: Boolean) = Unit
        override fun tap() = Unit
        override fun toggleMute() = Unit
        override fun end() = Unit
        override suspend fun answer(option: VoiceQuestion.Option, questionId: String) = true
        override fun cancelGrace() = Unit
        override suspend fun doItNow() = Unit
        override fun switchSession(agent: String, machine: String) = Unit
        override suspend fun setPersona(id: String) = Unit
        override fun playSample(id: String) = Unit
        override fun setAttention(attention: VoiceAttention) = Unit
        override fun setTurns(turns: VoiceTurns) = Unit
        override fun revokeConsent() = Unit
    }
}

@Composable
private fun FixturePreview(name: String, dark: Boolean = false) = PiTheme(darkTheme = dark) {
    VoiceScreen(VoiceFixtures.model(name), VoiceFixtures.NoActions, levels = { VoiceFixtures.levels(name) })
}

@Preview(name = "Listening", heightDp = 780) @Composable private fun ListeningPreview() = FixturePreview("listening")
@Preview(name = "Working", heightDp = 780) @Composable private fun WorkingPreview() = FixturePreview("working")
@Preview(name = "Asking, dark", heightDp = 780) @Composable private fun AskingPreview() = FixturePreview("asking", dark = true)
@Preview(name = "Undo window", heightDp = 780) @Composable private fun GracePreview() = FixturePreview("grace")
@Preview(name = "Muted", heightDp = 780) @Composable private fun MutedPreview() = FixturePreview("muted")
@Preview(name = "Settings", heightDp = 780) @Composable private fun SettingsPreview() = PiTheme {
    VoiceSettingsContent(VoiceFixtures.model("listening"), VoiceFixtures.NoActions, onDone = {}, onVoices = {}, onRevoke = {})
}
