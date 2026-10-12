package dev.pi_mobile.app.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.Visualizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.util.Locale
import kotlin.math.pow

/**
 * Basic voice's audio (`startCascade`, `speak`, `speakLocal`, `silence` in web/voice.js): the mic as 16 kHz
 * frames (AudioRecord), pi's audio from the computer (MediaPlayer) and the phone's own synthesis
 * (TextToSpeech). The audio mode and route are the [AudioSessionController]'s. Port of the audio half of
 * native/ios/Pi/Voice/BasicVoice.swift. Callbacks reach the engine on [scope] (its main dispatcher).
 */
class AndroidBasicAudio(context: Context, private val scope: CoroutineScope) : BasicAudio {
    private val app = context.applicationContext
    private var recorder: AudioRecord? = null
    private var echo: AcousticEchoCanceler? = null
    private var player: MediaPlayer? = null
    private var playerDone: (() -> Unit)? = null
    private var meter: Visualizer? = null
    private var meterJob: Job? = null
    private var ducked = false

    override var outLevel: Double? = null
        private set

    override val isSpeaking: Boolean get() = player?.isPlaying == true || tts.isSpeaking

    // Mic

    /** Needs RECORD_AUDIO (VoiceHost checks it before voice mode starts). */
    @SuppressLint("MissingPermission")
    override fun start(onFrame: (FloatArray, Double) -> Unit) {
        stop()
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT,
            maxOf(min, FRAME * 4 * 2),
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException("No microphone input.")
        }
        // The device's echo canceller on the capture, so pi's own voice is not heard. [verify]
        if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true }
        rec.startRecording()
        recorder = rec
        Thread({
            val buf = FloatArray(FRAME)
            while (recorder === rec) {
                val n = rec.read(buf, 0, FRAME, AudioRecord.READ_BLOCKING)
                if (n <= 0) continue
                val frame = buf.copyOf(n)
                scope.launch { if (recorder === rec) onFrame(frame, RATE.toDouble()) }
            }
        }, "pi-basic-voice-mic").start()
    }

    override fun stop() {
        val rec = recorder ?: return
        recorder = null // the reader thread ends at its next read
        echo?.release()
        echo = null
        rec.stop()
        rec.release()
    }

    // Computer audio

    override fun play(audio: ByteArray, mime: String, done: () -> Unit) {
        stopPlayer()
        val file = File(app.cacheDir, "pi-speech.${extension(mime)}").apply { writeBytes(audio) }
        val p = MediaPlayer()
        try {
            p.setAudioAttributes(AudioSessionController.VOICE)
            p.setDataSource(file.path)
            p.prepare()
        } catch (e: Exception) {
            p.release()
            done()
            throw e
        }
        p.setVolume(volume, volume)
        p.setOnCompletionListener { finishPlayer(p) }
        p.setOnErrorListener { _, _, _ -> finishPlayer(p); true }
        player = p
        playerDone = done
        outLevel = 0.0
        p.start()
        startMeter(p)
    }

    /** pi's level while the computer's audio plays. [verify] Visualizer works on a voice-communication stream. */
    private fun startMeter(p: MediaPlayer) {
        meter = try {
            Visualizer(p.audioSessionId).apply {
                measurementMode = Visualizer.MEASUREMENT_MODE_PEAK_RMS
                enabled = true
            }
        } catch (_: Exception) {
            null // no level: the orb gets the engine's gentle motion instead
        }
        val v = meter ?: return
        meterJob = scope.launch {
            val m = Visualizer.MeasurementPeakRms()
            while (isActive && player === p) {
                if (v.getMeasurementPeakRms(m) == Visualizer.SUCCESS) outLevel = 10.0.pow(m.mRms / 2000.0).coerceIn(0.0, 1.0)
                delay(50)
            }
        }
    }

    private fun finishPlayer(p: MediaPlayer) {
        if (p !== player) return
        val done = playerDone
        stopPlayer()
        done?.invoke()
    }

    private fun stopPlayer() {
        meterJob?.cancel()
        meterJob = null
        meter?.release()
        meter = null
        player?.run {
            setOnCompletionListener(null)
            setOnErrorListener(null)
            try { stop() } catch (_: IllegalStateException) {}
            release()
        }
        player = null
        playerDone = null
        outLevel = null
    }

    // Phone synthesis

    private var ttsReady: Boolean? = null
    private val tts: TextToSpeech = TextToSpeech(app) { status ->
        scope.launch {
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady == true) tts.setAudioAttributes(AudioSessionController.VOICE)
            val s = speech
            if (s != null && ttsReady == false) finishSpeech() else if (s != null && !ducked) speakFrom(s.next)
        }
    }.apply { setOnUtteranceProgressListener(Progress()) }

    /** What the phone is saying: [next] is the part to (re)start from, e.g. after ducking. */
    private class Speech(val parts: List<String>, val persona: VoicePersona?, val rate: Double, val done: () -> Unit, var next: Int = 0)
    private var speech: Speech? = null
    /** Bumped by every (re)start, so callbacks from stopped utterances are ignored. */
    private var speechGen = 0

    override fun speakLocal(parts: List<String>, persona: VoicePersona?, rate: Double, done: () -> Unit) {
        cancelSpeech()
        val said = parts.filter { it.isNotBlank() }
        if (said.isEmpty()) return done()
        speech = Speech(said, persona, rate, done)
        when (ttsReady) {
            true -> if (!ducked) speakFrom(0)
            false -> finishSpeech()
            null -> {} // starts once the engine is ready
        }
    }

    private fun speakFrom(index: Int) {
        val s = speech ?: return
        speechGen += 1
        phoneVoice(tts.voices.orEmpty(), s.persona)?.let { tts.voice = it }
        tts.setSpeechRate(s.rate.coerceIn(0.5, 2.0).toFloat())
        tts.setPitch((s.persona?.phonePitch ?: 1.0).coerceIn(0.5, 2.0).toFloat())
        for (i in index until s.parts.size) tts.speak(s.parts[i], TextToSpeech.QUEUE_ADD, null, "$speechGen:$i")
    }

    private fun partEnded(id: String) {
        val (gen, index) = id.split(":").map { it.toIntOrNull() ?: -1 }.let { it[0] to it.getOrElse(1) { -1 } }
        val s = speech ?: return
        if (gen != speechGen) return
        s.next = index + 1
        if (s.next >= s.parts.size) finishSpeech()
    }

    private fun finishSpeech() {
        val done = speech?.done
        speech = null
        done?.invoke()
    }

    private fun cancelSpeech() {
        speech = null
        speechGen += 1
        tts.stop()
    }

    private inner class Progress : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {}
        override fun onDone(utteranceId: String) {
            scope.launch { partEnded(utteranceId) }
        }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) {
            scope.launch { partEnded(utteranceId) }
        }
    }

    // Control

    override fun silence() {
        stopPlayer()
        cancelSpeech()
    }

    private val volume: Float get() = if (ducked) 0.2f else 1f

    /**
     * The phone's synthesis can't pause: ducking stops it and remembers the part it was on; unducking says
     * that part again from its start (iOS pauses and continues mid-word).
     */
    override fun setDucked(ducked: Boolean) {
        if (ducked == this.ducked) return
        this.ducked = ducked
        player?.setVolume(volume, volume)
        val s = speech ?: return
        if (ducked) {
            speechGen += 1
            tts.stop()
        } else if (ttsReady == true) speakFrom(s.next)
    }

    companion object {
        const val RATE = 16_000
        /** About 128 ms at 16 kHz, like the 2048-sample buffers at 48 kHz on iOS. */
        const val FRAME = 2048

        private fun extension(mime: String) = when {
            "wav" in mime -> "wav"
            "ogg" in mime || "opus" in mime -> "ogg"
            "mp4" in mime || "aac" in mime || "m4a" in mime -> "m4a"
            else -> "mp3"
        }

        /**
         * `phoneVoice()`: the current language; the persona's preferred names first, then high-quality
         * voices on the phone, then any.
         */
        fun phoneVoice(voices: Collection<Voice>, persona: VoicePersona?): Voice? {
            val lang = Locale.getDefault().language
            val prefer = persona?.phonePrefer.orEmpty().filter { it.isNotEmpty() }.joinToString("|")
            val re = prefer.takeIf { it.isNotEmpty() }?.let { runCatching { Regex(it, RegexOption.IGNORE_CASE) }.getOrNull() }
            fun rank(v: Voice): Int = when {
                re?.containsMatchIn(v.name) == true -> 0
                v.quality >= Voice.QUALITY_HIGH && !v.isNetworkConnectionRequired -> 1
                !v.isNetworkConnectionRequired -> 2
                else -> 3
            }
            return voices
                .filter { it.locale.language == lang && TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features.orEmpty() }
                .minByOrNull(::rank)
        }
    }
}
