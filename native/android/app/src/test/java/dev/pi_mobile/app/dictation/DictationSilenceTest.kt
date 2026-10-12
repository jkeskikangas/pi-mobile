package dev.pi_mobile.app.dictation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port of native/ios/PiTests/DictationSilenceTests.swift (issue #3): a muted or blocked microphone records digital
 * silence; dictation unmutes for the take and never sends silence, saying why instead. Plus the meter's scale.
 */
class DictationSilenceTest {
    private class FakeMute(private var muted: Boolean) : InputMute {
        var stuck = false
        val sets = mutableListOf<Boolean>()
        override val isInputMuted get() = muted
        override fun setInputMuted(muted: Boolean) {
            sets += muted
            if (!stuck) this.muted = muted
        }
    }

    @Test fun aMuteLeftByVoiceModeIsLiftedForTheTake() {
        val m = FakeMute(true)
        assertFalse(AudioRecorder.unmuteForTake(m))
        assertEquals(listOf(false), m.sets)
        assertFalse(m.isInputMuted)
    }

    @Test fun anUnmutedInputIsLeftAlone() {
        val m = FakeMute(false)
        assertFalse(AudioRecorder.unmuteForTake(m))
        assertEquals(emptyList<Boolean>(), m.sets)
    }

    @Test fun aMuteThatWontLiftIsReported() {
        val m = FakeMute(true).apply { stuck = true }
        assertTrue(AudioRecorder.unmuteForTake(m))
    }

    @Test fun silenceIsNamedInsteadOfSent() {
        assertNull("speech", AudioRecorder.silenceMessage(-20.0, stillMuted = false))
        assertNull("a quiet room is still a real microphone", AudioRecorder.silenceMessage(-75.0, stillMuted = false))
        assertEquals(
            "the microphone is muted for pi. Unmute it (your headset or voice mode) and try again.",
            AudioRecorder.silenceMessage(-160.0, stillMuted = true),
        )
        assertTrue(AudioRecorder.silenceMessage(-120.0, stillMuted = false)!!.contains("only silence"))
    }

    @Test fun maxAmplitudeMapsToDecibelsAndLevels() {
        assertEquals(AudioRecorder.SILENT_DB, AudioRecorder.decibels(0), 0.0)
        assertEquals(0.0, AudioRecorder.decibels(32_767), 1e-9)
        // The quietest non-zero reading is a real microphone (about -90 dB), not digital silence.
        assertNull(AudioRecorder.silenceMessage(AudioRecorder.decibels(1), stillMuted = false))
        assertEquals(0.0, AudioRecorder.level(0), 0.0)
        assertEquals(1.0, AudioRecorder.level(32_767 * 4), 0.0)
        assertEquals(1.0 / 3, AudioRecorder.level(32_767), 1e-9)
    }
}
