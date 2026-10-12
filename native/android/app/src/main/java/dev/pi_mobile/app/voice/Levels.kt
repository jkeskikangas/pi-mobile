package dev.pi_mobile.app.voice

import kotlin.math.sqrt

/**
 * Smoothed 0–1 levels for the voice UI, fed from WebRTC stats (`audioLevel`, linear 0–1). [RealtimeClient]
 * polls every 100 ms and feeds the raw values here. Port of native/ios/Pi/Voice/Levels.swift.
 */
class Levels {
    var mic = 0.0
        private set
    var pi = 0.0
        private set
    /** The mic's raw `audioLevel` (linear amplitude, like the web's RMS) for the VAD, unsmoothed. */
    var micRaw = 0.0
        private set

    fun update(rawMic: Double?, rawPi: Double?) {
        if (rawMic != null) {
            micRaw = if (rawMic.isFinite()) maxOf(0.0, rawMic) else 0.0
            mic = mic * 0.6 + scale(rawMic) * 0.4
        }
        if (rawPi != null) pi = pi * 0.6 + scale(rawPi) * 0.4
    }

    fun reset() {
        mic = 0.0
        pi = 0.0
        micRaw = 0.0
    }

    companion object {
        /**
         * Raw stats `audioLevel` (0–1 linear amplitude; speech sits around 0.02–0.3) → 0–1 for display.
         * sqrt lifts quiet speech; 1.6 gain so normal speech reaches ~0.6–0.9. [verify] feel on device.
         */
        fun scale(raw: Double): Double = if (!raw.isFinite() || raw <= 0) 0.0 else minOf(1.0, sqrt(raw) * 1.6)
    }
}
