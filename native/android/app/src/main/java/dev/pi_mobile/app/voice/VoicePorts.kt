package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.HubEvent
import dev.pi_mobile.app.core.Machine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlin.math.roundToLong

// The seams between VoiceEngine (pure behaviour, ported from web/voice.js) and the platform: the
// machines (sealed RPC + events), the realtime call (WebRTC), basic-voice audio and earcons.
// Tests drive the engine through fakes of these (test/.../voice/VoiceFakes.kt). Port of VoicePorts.swift.
// Everything here is called on the engine's single (main) thread.

/** One computer as voice mode sees it. */
data class FleetMachine(val id: String, val name: String)

sealed interface FleetUpdate {
    data class Event(val machine: String, val event: HubEvent) : FleetUpdate
    data class State(val machine: String, val state: ConnectionState) : FleetUpdate
}

/** Every paired machine: RPC per machine and one merged update stream. */
interface VoiceFleet {
    val machines: List<FleetMachine>
    /** A hub-level RPC (`hub`, `focus`, …) on one machine. */
    suspend fun rpc(machine: String, m: String, p: JsonElement): JsonElement
    /** An agent RPC (`agent { agent, m, p }`) on the machine that hosts `agent`. */
    suspend fun agentCall(machine: String, agent: String, m: String, p: JsonElement): JsonElement
    /** Asks that machine's stream for the detailed events of `agent`. */
    suspend fun focus(machine: String, agent: String)
    /** Hub events and connection states of every machine. One collector. */
    fun updates(): Flow<FleetUpdate>
    /** The network changed: reopen event streams. */
    fun reconnect()
    /** The app's machine list changed (added, removed, re-paired); returns the ids that are new or re-paired. */
    fun setMachines(list: List<Machine>): Set<String>
}

/** The OpenAI realtime call (WebRTC + `oai-events` data channel). `RealtimeClient` in the app. */
interface RealtimeTransport {
    /**
     * Builds the offer, hands it to [exchange] (the `voiceSession` RPC) and applies the answer;
     * returns once the data channel is open (throws "realtime voice did not connect" after 15 s).
     */
    suspend fun connect(exchange: suspend (offerSdp: String) -> String)
    /** Sends one client event on the data channel (dropped unless open). */
    fun send(event: JsonElement)
    /** Server events from the data channel, in order, on the engine's thread. */
    var onEvent: ((JsonElement) -> Unit)?
    /** The peer connection failed or closed after connecting. */
    var onLost: (() -> Unit)?
    /** The microphone track's `enabled`. */
    var micEnabled: Boolean
    /** pi's voice volume, 1 normal, 0.2 ducked. */
    var remoteVolume: Double
    /** Smoothed levels (0–1): the mic and pi's voice. */
    val micLevel: Double
    val piLevel: Double
    /** The mic's raw linear level for the client VAD (web: analyser RMS), not display-scaled. */
    val micRaw: Double
    fun close()
}

/**
 * Basic voice's audio (`startCascade`, `speak`, `speakLocal`, `silence`): the mic as frames, pi's audio
 * from the computer, and the phone's own synthesis. `BasicVoice` holds the pure parts (WAV, downsampling).
 */
interface BasicAudio {
    /**
     * Starts the mic; `onFrame(samples, sampleRate)` for each buffer (about 2048 samples), on the engine's
     * thread. Throws (with a sentence to show) when there is no microphone input.
     */
    fun start(onFrame: (FloatArray, Double) -> Unit)
    fun stop()
    /** Plays encoded audio from the computer (`speak` RPC); `done` when it ends or fails. Throws if it can't decode. */
    fun play(audio: ByteArray, mime: String, done: () -> Unit)
    /** Speaks with the phone's synthesizer: `parts` in order, `done` after the last. */
    fun speakLocal(parts: List<String>, persona: VoicePersona?, rate: Double, done: () -> Unit)
    /** Stops whatever is playing or speaking (no `done`). */
    fun silence()
    /** Output volume, 1 normal, 0.2 ducked; local synthesis pauses when ducked. */
    fun setDucked(ducked: Boolean)
    val isSpeaking: Boolean
    /** The output level (0–1) while the computer's audio plays, null for the phone's synthesis. */
    val outLevel: Double?
}

/** The short sounds from `PiVoiceCore.EARCONS`. */
interface EarconPlaying {
    fun play(name: String)
    /** Stops the earcon player (before the audio session is released). */
    fun stop()
}

/** The audio session: communication mode, focus/interruptions, routes, input mute (plan A9, D5, D8). */
interface VoiceAudioSession {
    /** Takes the audio (mode, focus, route); throws with a sentence to show while another app holds it. */
    fun activate()
    fun deactivate()
    val route: String
    /** Interruption began (`true`) / ended and may resume (`false`); ended without that → `null`. */
    var onInterruption: ((began: Boolean?) -> Unit)?
    var onRouteChange: ((String) -> Unit)?
    /** System input mute changed. */
    var onInputMute: ((Boolean) -> Unit)?
    fun setInputMuted(muted: Boolean)
    /** The system input mute now (it can outlive a session). */
    val isInputMuted: Boolean
    /** Headset or lock-screen play/pause: acts like tapping the circle. */
    var onRemoteToggle: (() -> Unit)?
    /** The network changed after being connected. */
    var onNetworkChange: (() -> Unit)?
}

/** Voice preferences shared with the web UI, which owns the keys (BRIDGE.md `prefs`). */
interface VoicePrefs {
    operator fun get(key: String): String?
    operator fun set(key: String, value: String?)
}

/** A cancellable timer from [VoiceScheduler]. */
class VoiceTimer(cancel: () -> Unit) {
    private var onCancel: (() -> Unit)? = cancel
    fun cancel() {
        onCancel?.invoke()
        onCancel = null
    }
}

/** setTimeout / setInterval; tests use a manual clock. */
interface VoiceScheduler {
    fun after(seconds: Double, f: () -> Unit): VoiceTimer
    fun every(seconds: Double, f: () -> Unit): VoiceTimer
}

/** The real one: coroutines on the engine's scope (the main dispatcher), so timers fire on the engine's thread. */
class CoroutineScheduler(private val scope: CoroutineScope) : VoiceScheduler {
    override fun after(seconds: Double, f: () -> Unit): VoiceTimer {
        val job = scope.launch {
            delay(millis(seconds))
            f()
        }
        return VoiceTimer { job.cancel() }
    }

    override fun every(seconds: Double, f: () -> Unit): VoiceTimer {
        val job = scope.launch {
            while (isActive) {
                delay(millis(seconds))
                f()
            }
        }
        return VoiceTimer { job.cancel() }
    }

    private fun millis(seconds: Double) = (seconds * 1000).roundToLong()
}

/** Everything the engine needs from outside; the app passes live parts, tests pass fakes. */
class VoiceDeps(
    val fleet: VoiceFleet,
    val core: VoiceCore,
    val makeRealtime: () -> RealtimeTransport,
    val makeBasic: () -> BasicAudio,
    val earcons: EarconPlaying,
    val audioSession: VoiceAudioSession?,
    val prefs: VoicePrefs,
    val scheduler: VoiceScheduler,
    /** Wall clock, epoch ms. */
    val now: () -> Long = System::currentTimeMillis,
    /** Monotonic ms for VAD frames. */
    val ms: () -> Double = { System.nanoTime() / 1e6 },
)

/**
 * Who holds the shared audio session (voice mode or dictation): the last to claim it. A holder releases
 * the session only if nobody claimed it since, so a late release never cuts the other one off.
 * Port of native/ios/Pi/Core/AudioOwner.swift (dictation shares it once ported).
 */
object AudioOwner {
    private var current = 0

    /** Takes the session; returns this holder's token. */
    @Synchronized fun claim(): Int = ++current

    /** True while nobody claimed the session after `token`. */
    @Synchronized fun owns(token: Int?): Boolean = token == current
}
