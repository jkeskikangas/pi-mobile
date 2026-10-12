package dev.pi_mobile.app.dictation

import android.Manifest
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.pi_mobile.app.shell.PermissionResult
import dev.pi_mobile.app.shell.Permissions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/** The app-wide microphone mute ([AudioManager.setMicrophoneMute]), a seam for tests. */
interface InputMute {
    val isInputMuted: Boolean
    fun setInputMuted(muted: Boolean)
}

class SystemInputMute(private val audio: AudioManager) : InputMute {
    override val isInputMuted: Boolean get() = audio.isMicrophoneMute
    override fun setInputMuted(muted: Boolean) {
        audio.isMicrophoneMute = muted
    }
}

/**
 * Dictation audio (plans/native-android.md A13): MediaRecorder, AAC in MPEG-4, mono, 16 kHz, into the cache directory,
 * read whole on stop and deleted. Holds transient audio focus while recording, so music pauses and resumes after.
 * Port of native/ios/Pi/Dictation/AudioRecorder.swift; main thread only.
 *
 * Interruptions end the take with a sentence ([onEnded] → `dictationEnded`): losing audio focus (a call, another
 * app recording), being silenced by the system (Android 10+ concurrent capture), the microphone being unplugged,
 * or a media server error.
 */
class AudioRecorder(
    private val context: Context,
    private val permissions: Permissions,
) : DictationRecorder {
    override var onEnded: ((String) -> Unit)? = null
    override var onLevel: ((Double) -> Unit)? = null

    private val audio = context.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /**
     * Voice mode's mute (or a headset) can leave the microphone muted app-wide; every later recording is then digital
     * silence (issue #3). Dictation is an explicit "listen now", so it lifts the mute for the take.
     */
    var inputMute: InputMute = SystemInputMute(audio)

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var focus: AudioFocusRequest? = null

    /** The loudest [MediaRecorder.getMaxAmplitude] of this take (0 = digital silence). */
    private var peak = 0

    private val meter = object : Runnable {
        override fun run() {
            val r = recorder ?: return
            // Max amplitude since the previous call: one reading per frame of the page's waveform.
            val amp = try { r.maxAmplitude } catch (_: IllegalStateException) { return }
            peak = max(peak, amp)
            onLevel?.invoke(level(amp))
            main.postDelayed(this, METER_MS)
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        // Ducking (a notification sound) is fine; anything that takes the audio away ends the take.
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) end(TAKEN)
    }

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
            // Before Android 9 there is no routed device to compare with; the system falls back to the built-in mic.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
            val routed = recorder?.routedDevice ?: return
            if (removed.any { it.isSource && it.id == routed.id }) end("Dictation stopped: the microphone was disconnected.")
        }
    }

    /** Android 10+: a call or a privileged app can silence our capture without taking focus. */
    private val silenced = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && recorder?.activeRecordingConfiguration?.isClientSilenced == true) end(TAKEN)
        }
    }

    override suspend fun start() {
        when (permissions.request(Manifest.permission.RECORD_AUDIO)) {
            PermissionResult.GRANTED -> Unit
            PermissionResult.DENIED -> throw DictationError(DENIED)
            PermissionResult.BLOCKED -> throw DictationError(DENIED, settings = true)
        }
        check(recorder == null) { "already recording" }
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener(focusListener, main)
            .build()
        if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            throw DictationError("a call or another app is using audio. Try again after it.")
        }
        focus = request
        if (unmuteForTake(inputMute)) {
            teardown()
            throw DictationError(silenceMessage(peakDb = SILENT_DB, stillMuted = true)!!)
        }
        val out = File(context.cacheDir, "dictation-${UUID.randomUUID()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioSamplingRate(SAMPLE_RATE)
            r.setAudioEncodingBitRate(BIT_RATE)
            r.setOutputFile(out.path)
            r.setOnErrorListener { _, what, _ ->
                end(if (what == MediaRecorder.MEDIA_ERROR_SERVER_DIED) "Dictation stopped: audio was reset. Try again." else "Recording failed.")
            }
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            out.delete()
            teardown()
            throw DictationError("couldn't start recording (${e.message ?: e.javaClass.simpleName}).")
        }
        recorder = r
        file = out
        peak = 0
        audio.registerAudioDeviceCallback(devices, main)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) audio.registerAudioRecordingCallback(silenced, main)
        main.post(meter)
    }

    override suspend fun stop(): ByteArray {
        val r = recorder ?: throw DictationError("nothing is being recorded.")
        val out = file!!
        peak = max(peak, try { r.maxAmplitude } catch (_: IllegalStateException) { 0 })
        val muted = inputMute.isInputMuted
        // stop() throws when no audio frame was written (a tap shorter than the encoder's first frame).
        val stopped = try { r.stop(); true } catch (_: RuntimeException) { false }
        r.release()
        recorder = null
        file = null
        teardown()
        val data = withContext(Dispatchers.IO) {
            try { if (stopped) out.readBytes() else null } catch (_: Exception) { null } finally { out.delete() }
        } ?: throw DictationError("the recording couldn't be read.")
        val db = decibels(peak)
        Log.d(TAG, "peak ${db.toInt()} dB, ${data.size} bytes, muted $muted")
        // Never send silence to be transcribed into nothing: say why instead.
        silenceMessage(db, muted)?.let { throw DictationError(it) }
        return data
    }

    override fun cancel() {
        val r = recorder ?: return
        discard(r)
    }

    /** The system stopped us: discard and tell the page. */
    private fun end(message: String) {
        val r = recorder ?: return
        discard(r)
        onEnded?.invoke(message)
    }

    private fun discard(r: MediaRecorder) {
        try { r.stop() } catch (_: RuntimeException) {}
        r.release()
        recorder = null
        file?.delete()
        file = null
        teardown()
    }

    private fun teardown() {
        main.removeCallbacks(meter)
        audio.unregisterAudioDeviceCallback(devices)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) audio.unregisterAudioRecordingCallback(silenced)
        focus?.let { audio.abandonAudioFocusRequest(it) }
        focus = null
    }

    companion object {
        private const val TAG = "PiDictation"
        const val SAMPLE_RATE = 16_000
        private const val BIT_RATE = 32_000
        /** ~30 levels a second. */
        private const val METER_MS = 33L
        private const val FULL_SCALE = 32_767.0
        /** What [decibels] reports for no signal at all (AVAudioRecorder's floor, so the thresholds match iOS). */
        const val SILENT_DB = -160.0

        /**
         * Speech peaks run about 3× (≈10 dB) above its RMS; the page expects RMS (BRIDGE.md `level`) and draws
         * `sqrt(level)`, so the peak amplitude is scaled down to read like iOS's meter.
         */
        private const val CREST = 3.0

        const val DENIED = "Microphone access is off. Turn it on in Settings."
        private const val TAKEN = "Dictation stopped: another app or a call took the microphone."

        /** The page's level 0–1 (linear) for a [MediaRecorder.getMaxAmplitude] reading. */
        fun level(amplitude: Int): Double = min(1.0, max(0.0, amplitude / FULL_SCALE / CREST))

        /** dB full scale of a max-amplitude reading; [SILENT_DB] for 0. */
        fun decibels(amplitude: Int): Double = if (amplitude <= 0) SILENT_DB else 20 * log10(amplitude / FULL_SCALE)

        /** The sentence to show instead of sending a take whose loudest moment was silence, else null. */
        fun silenceMessage(peakDb: Double, stillMuted: Boolean): String? {
            // Only digital silence (a muted or blocked input): a real microphone in a quiet room reads about
            // -70 dB or louder. Quiet speech is the hub's call (`silent` from transcribe).
            if (peakDb > -100) return null
            if (stillMuted) return "the microphone is muted for pi. Unmute it (your headset or voice mode) and try again."
            return "the microphone recorded only silence. Check that Microphone access is on in Quick Settings and that no other app or call is using it, then try again."
        }

        /** Unmutes the app-wide input mute for a take; returns whether it is still muted afterwards. */
        fun unmuteForTake(m: InputMute): Boolean {
            if (m.isInputMuted) m.setInputMuted(false)
            return m.isInputMuted
        }
    }
}
