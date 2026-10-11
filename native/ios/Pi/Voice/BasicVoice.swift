import AVFoundation
import Foundation

/// Basic voice's audio (`startCascade`, `speak`, `speakLocal`, `silence` in web/voice.js).
/// The AVAudioSession is configured elsewhere (AudioSessionController); this only runs the engine,
/// the player and the synthesizer.
@MainActor
final class BasicVoice: BasicAudio {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayer?
    private var playerDone: (@MainActor () -> Void)?
    private let synth = AVSpeechSynthesizer()
    private var lastUtterance: AVSpeechUtterance?
    private var speakDone: (@MainActor () -> Void)?
    private var ducked = false
    private var meterTimer: Timer?
    private(set) var outLevel: Double?
    private lazy var delegate = Delegate(owner: self)

    init() {
        synth.delegate = delegate
    }

    var isSpeaking: Bool { (player?.isPlaying ?? false) || synth.isSpeaking }

    // MARK: mic

    func start(onFrame: @escaping @MainActor ([Float], Double) -> Void) throws {
        stop()
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // Apple's voice processing (echo cancellation) before the tap, so pi's own voice is not heard. [verify]
        try? input.setVoiceProcessingEnabled(true)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "BasicVoice", code: 1, userInfo: [NSLocalizedDescriptionKey: "no microphone input"])
        }
        let rate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 2048, format: format, block: Self.tap(rate: rate, onFrame))
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        self.engine = engine
    }

    /// Built outside the main actor: the tap runs on the audio thread (a main-actor closure would trap).
    private nonisolated static func tap(rate: Double, _ onFrame: @escaping @MainActor ([Float], Double) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            guard let ch = buffer.floatChannelData else { return }
            let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(buffer.frameLength)))
            Task { @MainActor in onFrame(samples, rate) }
        }
    }

    func stop() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    // MARK: computer audio

    func play(_ audio: Data, mime: String, done: @escaping @MainActor () -> Void) throws {
        stopPlayer()
        let p: AVAudioPlayer
        do { p = try AVAudioPlayer(data: audio) } catch {
            done()
            throw error
        }
        p.delegate = delegate
        p.isMeteringEnabled = true
        p.volume = ducked ? 0.2 : 1
        player = p
        playerDone = done
        outLevel = 0
        guard p.play() else {
            finishPlayer(p)
            return
        }
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.meter() }
        }
    }

    private func meter() {
        guard let p = player, p.isPlaying else { return }
        p.updateMeters()
        let db = Double(p.averagePower(forChannel: 0))
        outLevel = max(0, min(1, pow(10, db / 20)))
    }

    fileprivate func finishPlayer(_ p: AVAudioPlayer) {
        guard p === player else { return }
        let done = playerDone
        stopPlayer()
        done?()
    }

    private func stopPlayer() {
        meterTimer?.invalidate()
        meterTimer = nil
        player?.delegate = nil
        player?.stop()
        player = nil
        playerDone = nil
        outLevel = nil
    }

    // MARK: phone synthesis

    func speakLocal(_ parts: [String], persona: VoicePersona?, rate: Double, done: @escaping @MainActor () -> Void) {
        cancelSpeech()
        let parts = parts.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !parts.isEmpty else { done(); return }
        let voice = Self.phoneVoice(persona)
        let r = Float(max(0.5, min(2, rate))) * AVSpeechUtteranceDefaultSpeechRate
        speakDone = done
        for text in parts {
            let u = AVSpeechUtterance(string: text)
            u.voice = voice
            u.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, r))
            if let persona { u.pitchMultiplier = Float(max(0.5, min(2, persona.phonePitch))) }
            lastUtterance = u
            synth.speak(u)
        }
        if ducked { synth.pauseSpeaking(at: .immediate) }
    }

    fileprivate func utteranceEnded(_ u: AVSpeechUtterance) {
        guard u === lastUtterance else { return }
        let done = speakDone
        lastUtterance = nil
        speakDone = nil
        done?()
    }

    private func cancelSpeech() {
        lastUtterance = nil
        speakDone = nil
        if synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
    }

    /// `phoneVoice()`: the current language; persona's preferred names first, then enhanced/premium.
    static func phoneVoice(_ persona: VoicePersona?) -> AVSpeechSynthesisVoice? {
        let lang = Locale.current.language.languageCode?.identifier ?? "en"
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(lang) }
        let prefer = (persona?.phonePrefer ?? []).joined(separator: "|")
        let re = prefer.isEmpty ? nil : try? NSRegularExpression(pattern: prefer, options: [.caseInsensitive])
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            if let re, re.firstMatch(in: v.name, range: NSRange(v.name.startIndex..., in: v.name)) != nil { return 0 }
            if v.quality == .enhanced || v.quality == .premium { return 1 }
            return 2
        }
        return voices.min { rank($0) < rank($1) } ?? AVSpeechSynthesisVoice(language: Locale.current.identifier)
    }

    // MARK: control

    func silence() {
        stopPlayer()
        cancelSpeech()
    }

    func setDucked(_ ducked: Bool) {
        self.ducked = ducked
        player?.volume = ducked ? 0.2 : 1
        if ducked { if synth.isSpeaking { synth.pauseSpeaking(at: .immediate) } }
        else if synth.isPaused { synth.continueSpeaking() }
    }

    // MARK: pure helpers

    /// Index picking like the web: `out[i] = all[floor(i * ratio)]`.
    nonisolated static func downsample(_ samples: [Float], from rate: Double, to target: Double = 16000) -> [Float] {
        guard rate > target, !samples.isEmpty else { return samples }
        let ratio = rate / target
        let n = Int((Double(samples.count) / ratio).rounded(.down))
        return (0..<n).map { samples[min(samples.count - 1, Int((Double($0) * ratio).rounded(.down)))] }
    }

    /// 16-bit PCM mono WAV, as the web `wav()`.
    nonisolated static func wav(_ samples: [Float], rate: Int) -> Data {
        var d = Data(capacity: 44 + samples.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8))
        u32(UInt32(36 + samples.count * 2))
        d.append(contentsOf: Array("WAVEfmt ".utf8))
        u32(16); u16(1); u16(1)
        u32(UInt32(rate)); u32(UInt32(rate * 2))
        u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8))
        u32(UInt32(samples.count * 2))
        for s in samples {
            let v = Int16(max(-1, min(1, s)) * 0x7fff)
            u16(UInt16(bitPattern: v))
        }
        return d
    }

    // MARK: delegates

    private final class Delegate: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate, @unchecked Sendable {
        weak var owner: BasicVoice?
        init(owner: BasicVoice) { self.owner = owner }

        nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
            let p = UncheckedBox(player)
            Task { @MainActor [weak self] in self?.owner?.finishPlayer(p.value) }
        }
        nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
            let p = UncheckedBox(player)
            Task { @MainActor [weak self] in self?.owner?.finishPlayer(p.value) }
        }
        nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
            let u = UncheckedBox(utterance)
            Task { @MainActor [weak self] in self?.owner?.utteranceEnded(u.value) }
        }
        nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
            let u = UncheckedBox(utterance)
            Task { @MainActor [weak self] in self?.owner?.utteranceEnded(u.value) }
        }
    }
}

private struct UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ v: T) { value = v }
}
