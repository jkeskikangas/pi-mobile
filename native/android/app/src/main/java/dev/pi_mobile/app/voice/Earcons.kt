package dev.pi_mobile.app.voice

import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The short sounds from `PiVoiceCore.EARCONS`, pre-rendered to PCM and played as voice communication, so
 * they mix with the call and the echo canceller knows them. [verify] they aren't cancelled away on device.
 * Port of native/ios/Pi/Voice/Earcons.swift.
 */
class Earcons(steps: Map<String, List<List<Double>>>) : EarconPlaying {
    private val pcm = steps.mapValues { render(it.value) }.filterValues { it.isNotEmpty() }
    private val tracks = mutableMapOf<String, AudioTrack>()

    override fun play(name: String) {
        val track = tracks[name] ?: pcm[name]?.let(::load)?.also { tracks[name] = it } ?: return
        try {
            if (track.playState == AudioTrack.PLAYSTATE_PLAYING) track.stop()
            track.reloadStaticData()
            track.play()
        } catch (_: IllegalStateException) {
            // A sound is a nicety: never let it break voice mode.
        }
    }

    override fun stop() {
        tracks.values.forEach { it.release() }
        tracks.clear()
    }

    private fun load(samples: ShortArray): AudioTrack? = try {
        AudioTrack.Builder()
            .setAudioAttributes(AudioSessionController.VOICE)
            .setAudioFormat(
                AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build(),
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(samples.size * 2)
            .build()
            .also { it.write(samples, 0, samples.size) }
    } catch (_: Exception) {
        null
    }

    companion object {
        const val SAMPLE_RATE = 48_000

        /** Steps of [hz, ms, gain]; hz 0 = silence. Sine with 5 ms fades in and out, as 16-bit PCM. */
        fun render(steps: List<List<Double>>, sampleRate: Int = SAMPLE_RATE): ShortArray {
            val sr = sampleRate.toDouble()
            val counts = steps.map { max(0, ((it.getOrElse(1) { 0.0 }) / 1000 * sr).toInt()) }
            val out = ShortArray(counts.sum())
            val fade = max((0.005 * sr).toInt(), 1)
            var i = 0
            for ((step, n) in steps.zip(counts)) {
                val hz = step.firstOrNull() ?: 0.0
                val gain = step.getOrElse(2) { 0.2 }
                for (k in 0 until n) {
                    var v = 0.0
                    if (hz > 0) {
                        val env = min(1.0, min(k, n - 1 - k).toDouble() / fade)
                        v = sin(2 * PI * hz * k / sr) * gain * env
                    }
                    out[i++] = (v.coerceIn(-1.0, 1.0) * Short.MAX_VALUE).toInt().toShort()
                }
            }
            return out
        }
    }
}
