import AVFAudio

/// The short sounds from `PiVoiceCore.EARCONS`, pre-rendered to PCM and played on a private engine.
/// Doesn't touch the audio session (RTCAudioSession owns it). [verify] that a separate AVAudioEngine
/// output mixes with WebRTC's VPIO output under .playAndRecord/.voiceChat and isn't echo-cancelled away.
@MainActor
final class Earcons: EarconPlaying {
    private let sampleRate: Double = 48_000
    private let format: AVAudioFormat?
    private var buffers: [String: AVAudioPCMBuffer] = [:]
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var attached = false

    init(steps: [String: [[Double]]]) {
        format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
        guard let format else { return }
        for (name, s) in steps {
            if let b = Self.render(s, format: format) { buffers[name] = b }
        }
    }

    func play(_ name: String) {
        guard let buffer = buffers[name], start() else { return }
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        if !player.isPlaying { player.play() }
    }

    private func start() -> Bool {
        guard let format else { return false }
        if !attached {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            attached = true
        }
        if engine.isRunning { return true }
        do { try engine.start(); return true } catch { return false }
    }

    /// Steps of [hz, ms, gain]; hz 0 = silence. Sine with 5 ms fades in and out.
    private static func render(_ steps: [[Double]], format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let sr = format.sampleRate
        let counts = steps.map { max(0, Int(($0.count > 1 ? $0[1] : 0) / 1000 * sr)) }
        let total = counts.reduce(0, +)
        guard total > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)),
              let out = buf.floatChannelData?[0] else { return nil }
        buf.frameLength = AVAudioFrameCount(total)
        let fade = Int(0.005 * sr)
        var i = 0
        for (step, n) in zip(steps, counts) {
            let hz = step.first ?? 0
            let gain = step.count > 2 ? step[2] : 0.2
            for k in 0..<n {
                var v = 0.0
                if hz > 0 {
                    let env = min(1, Double(min(k, n - 1 - k)) / Double(max(fade, 1)))
                    v = sin(2 * .pi * hz * Double(k) / sr) * gain * env
                }
                out[i] = Float(v)
                i += 1
            }
        }
        return buf
    }
}
