package dev.pi_mobile.app.dictation

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale

/** The audio side of dictation, swapped for a fake in tests. Called on the main thread. */
interface DictationRecorder {
    /** Called with a user-facing message when the system stops the recording on its own. */
    var onEnded: ((String) -> Unit)?

    /** Input level 0–1 about 30 times a second while recording (BRIDGE.md `level`). */
    var onLevel: ((Double) -> Unit)?

    suspend fun start()

    /** The whole take (AAC in MPEG-4); throws [DictationError] when there is none or it was silence. */
    suspend fun stop(): ByteArray

    /** Stops and discards the take; no-op when not recording. */
    fun cancel()
}

/**
 * A dictation failure. [message] is a fragment the page shows after "Microphone: " or "Voice input failed: ";
 * [settings] means the microphone permission is blocked and only Settings can turn it back on.
 */
class DictationError(override val message: String, val settings: Boolean = false) : Exception(message)

/**
 * Composer dictation per BRIDGE.md: `dictation.start` / `.stop` / `.cancel`, and `level` / `dictationEnded` back to the
 * page. One take at a time; every cancel or system end bumps [take] so a late start or stop knows its take was given
 * up (BRIDGE.md → Dictation ordering). Confined to the main thread. Port of native/ios/Pi/Dictation/Dictation.swift.
 *
 * @param scope where a starting recorder runs, so a cancel can wait for it to release the microphone. Needs a
 *   SupervisorJob: a failed start is reported to its caller, not to the scope.
 */
class Dictation(private val recorder: DictationRecorder, private val scope: CoroutineScope) {
    enum class State { IDLE, STARTING, RECORDING, STOPPING }

    var state = State.IDLE
        private set
    private var take = 0
    private var startJob: Deferred<Unit>? = null

    /** Runs JavaScript in the page; set by the web shell that owns the take. */
    var js: (String) -> Unit = {}

    /** A light tick when recording starts and stops. */
    var haptic: () -> Unit = {}

    /** The microphone is blocked: offer Settings (the page shows the error text too). */
    var onDenied: (String) -> Unit = {}

    /** The user's OK to send audio, asked before the first take (ConsentController.ensure(DICTATION)). */
    var consent: suspend () -> Unit = {}

    init {
        recorder.onEnded = { systemEnded(it) }
        recorder.onLevel = { x ->
            if (state == State.RECORDING) js("window.PiNative?.level?.(${String.format(Locale.US, "%.3f", x)})")
        }
    }

    suspend fun start() {
        if (state != State.IDLE) throw DictationError("already recording.")
        // A cancel (or revocation) while the consent sheet is up gives this take up.
        val asked = take
        consent()
        if (take != asked) throw DictationError("cancelled.")
        if (state != State.IDLE) throw DictationError("already recording.")
        state = State.STARTING
        val mine = take
        val job = scope.async {
            recorder.start()
            // Cancelled (or ended) while starting: release the mic here, so draining this job means it's free.
            if (take != mine) recorder.cancel()
        }
        startJob = job
        try {
            job.await()
        } catch (e: Exception) {
            if (take == mine) state = State.IDLE
            startJob = null
            if (e is DictationError && e.settings) onDenied(e.message)
            throw e
        }
        startJob = null
        // Given up while starting (the job already released the mic); the web sends cancel anyway.
        if (take != mine) return
        state = State.RECORDING
        haptic()
    }

    suspend fun stop(): ByteArray {
        if (state == State.STARTING) {
            try { startJob?.await() } catch (_: Exception) { currentCoroutineContext().ensureActive() }
            yield()
        }
        if (state != State.RECORDING) throw DictationError("nothing is being recorded.")
        state = State.STOPPING
        val mine = take
        haptic()
        val data = try {
            recorder.stop()
        } catch (e: Exception) {
            if (take == mine) state = State.IDLE
            throw e
        }
        if (take != mine) throw DictationError("cancelled.")
        state = State.IDLE
        return data
    }

    /** Idempotent: always succeeds. A starting take is released by [start] once the recorder resolves. */
    fun cancel() {
        take += 1
        val was = state
        state = State.IDLE
        if (was == State.RECORDING || was == State.STOPPING) recorder.cancel()
    }

    /**
     * Stops and discards a take (or a pending start/stop) without telling the page, before voice mode takes the
     * microphone (BRIDGE.md `voice.start`). Returns once a pending start has resolved and released the microphone.
     */
    suspend fun cancelIfActive() {
        val pending = startJob
        if (state != State.IDLE) cancel()
        try { pending?.await() } catch (e: CancellationException) { currentCoroutineContext().ensureActive() } catch (_: Exception) {}
    }

    /** Consent was taken back: discard any take (a pending stop then fails) and drop the page's recorder UI. */
    fun consentRevoked() {
        val active = state != State.IDLE
        cancel()
        if (active) js(ended("Voice sharing is off."))
    }

    /**
     * The app left the screen. iOS keeps a take recording in the background (its audio background mode); Android
     * silences the microphone of an app in the background unless a foreground service holds it, and dictation has
     * none, so the take ends here with a sentence rather than being cut off silently.
     */
    fun appStopped() {
        val was = state
        if (was == State.IDLE) return
        take += 1
        state = State.IDLE
        if (was == State.RECORDING || was == State.STOPPING) recorder.cancel()
        js(ended(BACKGROUND))
    }

    private fun systemEnded(message: String) {
        if (state == State.IDLE) return
        take += 1
        state = State.IDLE
        js(ended(message))
    }

    private fun ended(message: String) = "window.PiNative?.dictationEnded?.(${JsonPrimitive(message)})"

    companion object {
        const val BACKGROUND = "Dictation stopped: pi left the screen."
    }
}
