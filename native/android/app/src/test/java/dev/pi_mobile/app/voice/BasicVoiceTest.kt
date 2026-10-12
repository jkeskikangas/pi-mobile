package dev.pi_mobile.app.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Port of native/ios/PiTests/Voice/BasicVoiceTests.swift. */
class BasicVoiceTest {
    @Test fun downsamplePicksIndices() {
        val s = FloatArray(12) { it.toFloat() }
        assertArrayEquals(floatArrayOf(0f, 3f, 6f, 9f), BasicVoice.downsample(s, 48000.0), 0f)
        assertArrayEquals(floatArrayOf(0f, 1f, 3f, 4f, 6f, 7f, 9f, 10f), BasicVoice.downsample(s, 24000.0, 16000.0), 0f)
        assertArrayEquals(s, BasicVoice.downsample(s, 16000.0), 0f)
    }

    @Test fun wavHeader() {
        val d = BasicVoice.wav(floatArrayOf(0f, 1f, -1f, 2f), 16000)
        assertEquals(44 + 8, d.size)
        val b = ByteBuffer.wrap(d).order(ByteOrder.LITTLE_ENDIAN)
        fun str(o: Int, n: Int) = String(d, o, n, Charsets.US_ASCII)
        assertEquals("RIFF", str(0, 4))
        assertEquals(36 + 8, b.getInt(4))
        assertEquals("WAVEfmt ", str(8, 8))
        assertEquals(16, b.getInt(16))
        assertEquals(16000, b.getInt(24))
        assertEquals(32000, b.getInt(28))
        assertEquals("data", str(36, 4))
        assertEquals(8, b.getInt(40))
        assertEquals(listOf(0, 0x7fff, -0x7fff, 0x7fff), listOf(44, 46, 48, 50).map { b.getShort(it).toInt() })
    }
}
