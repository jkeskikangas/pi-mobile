package dev.pi_mobile.app.voiceui

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement

/** What the voice screen shows, in `web/voice.js` terms (`LABEL`). Muted is [VoiceScreenModel.muted] on [PAUSED]. */
enum class VoiceState { CONNECTING, LISTENING, HEARING, THINKING, WORKING, SPEAKING, ASKING, PAUSED, OFFLINE }

/** `eyes-busy` (default) or `glance` (`pi-mobile-voice-attention`). */
enum class VoiceAttention { EYES_BUSY, GLANCE }

/** Open mic or push to talk (`tap`) (`pi-mobile-voice-turns`). */
enum class VoiceTurns { OPEN, TAP }

/** Which engine carries the call: OpenAI realtime over WebRTC, or basic voice (transcribe + speak). */
enum class VoiceEngineKind { REALTIME, BASIC }

/** A voice the computer offers (`voices` RPC); the screen needs only what it lists. */
@Immutable
data class VoicePersona(val id: String, val name: String, val blurb: String)

/** The question card: pi's open dialog, answered by voice or a tap (`renderAsk`). */
@Immutable
data class VoiceQuestion(
    val id: String,
    /** confirm | select | input */
    val kind: String,
    val title: String,
    val message: String? = null,
    val destructive: Boolean = false,
    /** Empty for free-text questions: the card says "Say your answer." */
    val options: List<Option> = emptyList(),
    val grace: Grace? = null,
) {
    @Immutable
    data class Option(
        val label: String,
        /** The JSON value `answer` sends: true/false for confirm, the option text for select, null = cancel. */
        val value: JsonElement?,
        val destructive: Boolean = false,
        val primary: Boolean = false,
        /** A quiet text answer under the others (select's Cancel). */
        val ghost: Boolean = false,
    )

    /** The undo window (`startGrace`): going ahead at [untilMillis] (wall clock) unless cancelled. */
    @Immutable
    data class Grace(val untilMillis: Long, val totalMillis: Long) {
        fun secondsLeft(now: Long = System.currentTimeMillis()): Int = maxOf(0, ((untilMillis - now + 999) / 1000).toInt())
        fun fraction(now: Long = System.currentTimeMillis()): Float = ((untilMillis - now).toFloat() / totalMillis).coerceIn(0f, 1f)
    }
}

/** Mic and pi levels for the orb (0–1, smoothed). */
@Immutable
data class VoiceLevels(val mine: Float = 0f, val pi: Float = 0f)

@Immutable
data class VoiceSettings(
    val attention: VoiceAttention = VoiceAttention.EYES_BUSY,
    val turns: VoiceTurns = VoiceTurns.OPEN,
    val persona: String = "marin",
    val personas: List<VoicePersona> = emptyList(),
    /** Why basic voice is used (kept for the settings sheet), null while realtime works. */
    val basicReason: String? = null,
)

/** A session the switcher lists (every reachable session on every machine). */
@Immutable
data class VoiceSessionItem(
    val agent: String,
    val machine: String,
    val name: String,
    /** Machine name, set only when there are several machines. */
    val machineName: String? = null,
    /** idle | working | waiting (the hub's status; waiting = a dialog in the terminal). */
    val status: String,
    /** Open questions for the phone. */
    val waiting: Int = 0,
)

/** One caption line: what you said (`heard`) or what pi says (`said`), [live] while still arriving. */
@Immutable
data class VoiceCaption(val text: String = "", val live: Boolean = false)

/**
 * Everything the voice screen reads from the engine (VoiceEngine.swift's observable surface), as one
 * immutable value: the screen is stateless and the engine maps its state here. The audio levels are
 * not in it: they change every frame and reach the orb through [VoiceScreen]'s `levels`, read while
 * drawing, so the screen doesn't recompose 60 times a second.
 */
@Immutable
data class VoiceScreenModel(
    val state: VoiceState = VoiceState.CONNECTING,
    /** The big state word (`LABEL` with the paused variants): "Listening", "pi needs you", "Mic off"… */
    val label: String = "",
    /** One line under it: what you can do now (`hint()`), with the working time. */
    val hint: String = "",
    /** What a tap on the circle does now, for TalkBack (`stageAction`): "Talk", "Interrupt", "Unmute"… */
    val stageAction: String = "",
    /** null while connecting or after the microphone failed (a tap retries). */
    val engineKind: VoiceEngineKind? = null,
    val heard: VoiceCaption = VoiceCaption(),
    val said: VoiceCaption = VoiceCaption(),
    /** A transient note under the captions (errors, "Using basic voice…"). */
    val note: String = "",
    val question: VoiceQuestion? = null,
    val muted: Boolean = false,
    /** Push to talk: holding the floor. */
    val talking: Boolean = false,
    /** Push to talk: a finger is on the circle. */
    val holding: Boolean = false,
    val agent: String = "",
    val machineId: String = "",
    val sessionName: String = "",
    /** The machine's name, shown only when there are several (else null). */
    val machineName: String? = null,
    /** The session's status line, the same as the app header ("Working · 0:42"). */
    val sessionLine: String = "",
    /** idle | working | waiting: the header dot. */
    val sessionStatus: String = "",
    val settings: VoiceSettings = VoiceSettings(),
    /** Sessions for the switcher. */
    val sessions: List<VoiceSessionItem> = emptyList(),
)

/** What the voice screen asks the engine to do (VoiceEngine.swift's public actions). Called on the main thread. */
interface VoiceActions {
    /** Push to talk: a finger went down on the circle. True if that started your turn (then [pressEnd] follows). */
    fun pressStart(): Boolean

    /** The finger that started a turn came up; [held] = it was a hold (or slid off), which ends the turn. */
    fun pressEnd(held: Boolean)

    /** A tap on the circle that didn't start a turn: interrupt pi, unmute, retry the mic, take or give the floor. */
    fun tap()

    fun toggleMute()

    /** End voice mode (End, back, TalkBack's escape). */
    fun end()

    /** A tap on an answer; only if [questionId] is still pi's open question. True when it was sent. */
    suspend fun answer(option: VoiceQuestion.Option, questionId: String): Boolean

    /** Cancel during the undo window: the question is answered no. */
    fun cancelGrace()

    /** "Do it now" during the undo window. */
    suspend fun doItNow()

    /** Follow another session from the switcher; the call stays up. */
    fun switchSession(agent: String, machine: String)

    /** A new voice; returns once it is in use (a realtime call redials). */
    suspend fun setPersona(id: String)

    /** A sample of [id] in the phone's own closest voice, for when there is no call to speak through. */
    fun playSample(id: String)

    fun setAttention(attention: VoiceAttention)

    fun setTurns(turns: VoiceTurns)

    /** Stop sharing my voice: forget the consent, discard any dictation take, end voice mode. */
    fun revokeConsent()
}
