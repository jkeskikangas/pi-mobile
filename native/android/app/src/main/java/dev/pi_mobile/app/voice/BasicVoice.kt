package dev.pi_mobile.app.voice

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The pure half of basic voice (`startCascade` in web/voice.js): the mic's frames become the 16 kHz
 * mono WAV the computer's `transcribe` takes. The cascade itself (utterance end, transcribe, distill,
 * send, speak via the hub's `speak` or the phone's synthesis) is in [VoiceEngine], as in the Swift app;
 * the audio I/O sits behind [BasicAudio] (AudioRecord / MediaPlayer / TextToSpeech in the app).
 * Port of the helpers in native/ios/Pi/Voice/BasicVoice.swift.
 */
object BasicVoice {
    /** Index picking like the web: `out[i] = all[floor(i * ratio)]`. */
    fun downsample(samples: FloatArray, from: Double, to: Double = 16000.0): FloatArray {
        if (from <= to || samples.isEmpty()) return samples
        val ratio = from / to
        val n = (samples.size / ratio).toInt()
        return FloatArray(n) { samples[minOf(samples.size - 1, (it * ratio).toInt())] }
    }

    /** 16-bit PCM mono WAV, as the web `wav()`. */
    fun wav(samples: FloatArray, rate: Int): ByteArray {
        val b = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()).putInt(36 + samples.size * 2)
        b.put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
        b.putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        b.put("data".toByteArray()).putInt(samples.size * 2)
        for (s in samples) b.putShort((s.coerceIn(-1f, 1f) * 0x7fff).toInt().toShort())
        return b.array()
    }
}
