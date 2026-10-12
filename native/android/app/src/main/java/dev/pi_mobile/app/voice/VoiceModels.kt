package dev.pi_mobile.app.voice

import kotlinx.serialization.json.JsonElement
import kotlin.math.ceil

// What voice mode shows and how it is set up: the types the UI binds to. The Swift app keeps these at
// the top of VoiceEngine.swift; they are a file of their own here so VoiceEngine.kt is only behaviour.

/** What the voice screen shows, in `web/voice.js` terms (`LABEL`). */
enum class VoiceState { CONNECTING, LISTENING, HEARING, THINKING, WORKING, SPEAKING, ASKING, PAUSED, OFFLINE }

/** `eyes-busy` (default) or `glance` (`pi-mobile-voice-attention`). */
enum class VoiceAttention(val raw: String) { EYES_BUSY("eyes-busy"), GLANCE("glance") }

/** Open mic (`open`) or push to talk (`tap`) (`pi-mobile-voice-turns`). */
enum class VoiceTurns(val raw: String) { OPEN("open"), TAP("tap") }

/** Which engine carries the call: OpenAI realtime over WebRTC, or basic voice (transcribe + speak). */
enum class VoiceEngineKind { REALTIME, BASIC }

/** A voice the computer offers (`voices` RPC). */
data class VoicePersona(
    val id: String,
    val name: String,
    val blurb: String,
    val rate: Double,
    val phonePrefer: List<String>,
    val phonePitch: Double,
)

/** The question card: pi's open dialog, answered by voice or a tap (`renderAsk`). */
data class VoiceQuestion(
    val id: String,
    /** confirm | select | input */
    val kind: String,
    val title: String,
    val message: String?,
    val destructive: Boolean,
    /** Empty for free-text questions: the card says "Say your answer." */
    val options: List<Option>,
    val grace: Grace?,
) {
    data class Option(
        val label: String,
        /** The JSON value `answer` sends: `true`/`false` for confirm, the option text for select, null = cancel. */
        val value: JsonElement?,
        val destructive: Boolean,
        val primary: Boolean = false,
        val ghost: Boolean = false,
    )

    /** The undo window (`startGrace`): going ahead at [untilMs] (epoch ms) unless cancelled. */
    data class Grace(val untilMs: Long, val totalSeconds: Double) {
        fun secondsLeft(nowMs: Long): Int = maxOf(0, ceil((untilMs - nowMs) / 1000.0).toInt())
        fun fraction(nowMs: Long): Double = ((untilMs - nowMs) / 1000.0 / totalSeconds).coerceIn(0.0, 1.0)
        /** "Going ahead in 3 s, as you asked. Say “stop” or tap Cancel." */
        fun text(nowMs: Long): String = "Going ahead in ${secondsLeft(nowMs)} s, as you asked. Say “stop” or tap Cancel."
    }
}

/** Mic and pi levels for the orb, the notification and the dictation strip (0–1, smoothed). */
data class VoiceLevels(val mine: Double = 0.0, val pi: Double = 0.0)

data class VoiceSettings(
    val attention: VoiceAttention = VoiceAttention.EYES_BUSY,
    val turns: VoiceTurns = VoiceTurns.OPEN,
    val persona: String = "marin",
    val personas: List<VoicePersona> = emptyList(),
    /** Why basic voice is used (kept for the settings sheet), null while realtime works. */
    val basicReason: String? = null,
)

/** A setting the user can change by voice or in the sheet (`applySetting`); [raw] is voice-core's command. */
enum class VoiceSetting(val raw: String) {
    PUSH_TO_TALK("pushToTalk"), OPEN_MIC("openMic"), EYES_FREE("eyesFree"), GLANCE("glance");

    companion object {
        fun of(raw: String?): VoiceSetting? = entries.firstOrNull { it.raw == raw }
    }
}

/** A session the switcher lists (every reachable session on every machine). */
data class VoiceSessionItem(
    val agent: String,
    val machine: String,
    val name: String,
    /** Machine name, set only when there are several machines. */
    val machineName: String?,
    val status: String,
    val waiting: Int,
) {
    val id: String get() = "$machine/$agent"
}

/** One caption line: what you said (`heard`) or what pi says (`said`), [live] while still arriving. */
data class VoiceCaption(val text: String = "", val live: Boolean = false)

/**
 * Everything the voice screen renders, as one immutable value ([VoiceEngine.ui]). The Swift engine's
 * observable properties, one for one; [label], [hint] and [stageAction] derive from them.
 */
data class VoiceUiState(
    /** True from `start` until `stop`. */
    val isOpen: Boolean = false,
    val state: VoiceState = VoiceState.CONNECTING,
    /** null while connecting or after the microphone failed (tap retries). */
    val engineKind: VoiceEngineKind? = null,
    val heard: VoiceCaption = VoiceCaption(),
    val said: VoiceCaption = VoiceCaption(),
    /** A transient note under the captions (errors, "Using basic voice…"). */
    val note: String = "",
    val question: VoiceQuestion? = null,
    val muted: Boolean = false,
    /** Push to talk: holding the floor / with a finger on the circle. */
    val talking: Boolean = false,
    val holding: Boolean = false,
    val agent: String = "",
    val machineId: String = "",
    val sessionName: String = "",
    /** The machine's name, shown only when there are several (else null). */
    val machineName: String? = null,
    /** The session's status line (same as the app header) and its dot class. */
    val sessionLine: String = "",
    val sessionStatus: String = "",
    /** Output route, e.g. "Pixel Buds" or "Speaker". */
    val route: String = "",
    val settings: VoiceSettings = VoiceSettings(),
    /** Sessions for the switcher. */
    val sessions: List<VoiceSessionItem> = emptyList(),
    /** Since when pi has worked (epoch ms, for the hint). */
    val workingSince: Long? = null,
    /** Times voice mode was opened (hints fade with use). */
    val uses: Int = 0,
    /** Epoch ms, bumped by the 1 s tick so time-dependent copy (hint, grace countdown) re-renders. */
    val now: Long = 0,
) {
    /** The big state word (`LABEL`, with the paused variants of `render`). */
    val label: String
        get() {
            if (state == VoiceState.PAUSED) return if (muted) "Mic off" else if (settings.turns == VoiceTurns.TAP) "Push to talk" else "Paused"
            return VoiceEngine.LABELS.getValue(state)
        }

    /** One line under the state: what you can do now (`hint()`). */
    val hint: String
        get() = when (state) {
            VoiceState.LISTENING -> when {
                uses > 6 -> ""
                uses <= 1 -> "Just talk — say “stop” any time"
                else -> TRIES[((now / 1000 / 8) % TRIES.size).toInt()]
            }
            VoiceState.WORKING -> {
                val s = workingSince?.let { maxOf(0L, (now - it) / 1000) } ?: 0L
                "${if (s >= 60) "${s / 60} min " else ""}${s % 60}s · ask “what's it doing?” any time"
            }
            VoiceState.SPEAKING -> "Talk or tap to interrupt"
            VoiceState.ASKING -> "Answer out loud, or tap below"
            VoiceState.PAUSED -> if (muted) "Tap to unmute" else if (settings.turns == VoiceTurns.TAP) "Hold while you talk, or tap to start and stop" else "Tap to resume"
            VoiceState.HEARING -> if (settings.turns != VoiceTurns.TAP) "" else if (holding) "Let go when you're done" else "Tap when you're done"
            else -> ""
        }

    /** The circle's accessibility action (`stageAction`). */
    val stageAction: String
        get() = when {
            engineKind == null -> "Retry the microphone"
            state == VoiceState.SPEAKING -> "Interrupt"
            muted -> "Unmute"
            settings.turns == VoiceTurns.TAP -> if (talking) "Done talking" else "Talk"
            else -> "Listening"
        }

    private companion object {
        val TRIES = listOf("Try “what's it doing?”", "Try “stop” — it works any time", "Try “tell me more”", "Try “switch to another session”", "Try “say that again”")
    }
}
