import Foundation

/// Smoothed 0–1 levels for the voice UI, fed from WebRTC stats (`audioLevel`, linear 0–1).
/// `RealtimeClient` polls every 100 ms and feeds the raw values here.
@MainActor
final class Levels {
    private(set) var mic: Double = 0
    private(set) var pi: Double = 0

    /// Raw stats `audioLevel` (0–1 linear amplitude; speech sits around 0.02–0.3) → 0–1 for display.
    /// sqrt lifts quiet speech; 1.6 gain so normal speech reaches ~0.6–0.9. [verify] feel on device.
    static func scale(_ raw: Double) -> Double {
        guard raw.isFinite, raw > 0 else { return 0 }
        return min(1, (raw.squareRoot() * 1.6))
    }

    func update(mic rawMic: Double?, pi rawPi: Double?) {
        if let rawMic { mic = mic * 0.6 + Self.scale(rawMic) * 0.4 }
        if let rawPi { pi = pi * 0.6 + Self.scale(rawPi) * 0.4 }
    }

    func reset() { mic = 0; pi = 0 }
}
