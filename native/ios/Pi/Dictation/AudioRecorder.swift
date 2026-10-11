import AVFoundation

/// The app-wide input mute (`AVAudioApplication`), a seam for tests.
@MainActor
protocol InputMute: AnyObject {
    var isInputMuted: Bool { get }
    func setInputMuted(_ muted: Bool) throws
}

@MainActor
final class SystemInputMute: InputMute {
    var isInputMuted: Bool { AVAudioApplication.shared.isInputMuted }
    func setInputMuted(_ muted: Bool) throws { try AVAudioApplication.shared.setInputMuted(muted) }
}

/// AVAudioRecorder: AAC in .m4a, mono, 16 kHz. The session is `.playAndRecord` only while recording.
@MainActor
final class AudioRecorder: NSObject, DictationRecorder, AVAudioRecorderDelegate {
    var onEnded: ((String) -> Void)?
    var onLevel: ((Double) -> Void)?
    /// Voice mode's mute (and AirPods / Control Center) sets the app-wide input mute, which outlives voice
    /// mode: every later recording is then digital silence (issue #3). Dictation is an explicit "listen now".
    var inputMute: InputMute = SystemInputMute()
    /// The loudest instantaneous level of this take, in dB (-160 = digital silence).
    private(set) var peakDB: Double = -160

    /// The sentence to show instead of sending a take whose loudest moment was silence, else nil.
    nonisolated static func silenceMessage(peakDB: Double, stillMuted: Bool) -> String? {
        // Only digital silence (a muted or blocked input): a real microphone in a quiet room still reads
        // about -70 dB or louder. Quiet speech is the hub's call (`silent` from transcribe).
        guard peakDB <= -100 else { return nil }
        if stillMuted { return "the microphone is muted for pi. Unmute it (AirPods stem, Control Center or voice mode) and try again." }
        return "the microphone recorded only silence. Check that no other app or call is using it and that pi has microphone access in Settings, then try again."
    }

    /// Unmutes the app-wide input mute for a take; returns whether it is still muted afterwards.
    static func unmuteForTake(_ m: InputMute) -> Bool {
        if m.isInputMuted {
            try? m.setInputMuted(false)
            print("pi dictation: the input was muted at start; unmuted for the take (still muted: \(m.isInputMuted))")
        }
        return m.isInputMuted
    }
    private var recorder: AVAudioRecorder?
    private var meter: Timer?
    /// Shared-session ownership (AudioOwner): release only if voice mode didn't take it since.
    private var audioToken: Int?
    private var observers: [NSObjectProtocol] = []
    private var stopping: CheckedContinuation<Data, Error>?

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else {
            throw DictationError(message: "access is off. Allow it in Settings → pi.", settings: true)
        }
        let s = AVAudioSession.sharedInstance()
        let url = FileManager.default.temporaryDirectory.appending(path: "dictation-\(UUID().uuidString).m4a")
        var made: AVAudioRecorder?
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try s.setActive(true)
            audioToken = AudioOwner.shared.claim()
            if Self.unmuteForTake(inputMute) {
                throw DictationError(message: Self.silenceMessage(peakDB: -160, stillMuted: true)!)
            }
            peakDB = -160
            let r = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ])
            made = r
            r.delegate = self
            r.isMeteringEnabled = true
            guard r.record() else { throw DictationError(message: "couldn't start recording.") }
            recorder = r
        } catch {
            made?.delegate = nil
            made?.stop()
            try? FileManager.default.removeItem(at: url)
            teardown()
            throw error is DictationError ? error : DictationError(message: "couldn't start recording (\(error.localizedDescription)).")
        }
        observe()
        meter = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let r = self?.recorder else { return }
                r.updateMeters()
                let db = Double(r.averagePower(forChannel: 0)) // -160…0
                if let self { self.peakDB = max(self.peakDB, Double(r.peakPower(forChannel: 0))) }
                self?.onLevel?(min(1, max(0, (db + 50) / 50)))
            }
        }
    }

    func stop() async throws -> Data {
        guard let r = recorder else { throw DictationError(message: "nothing is being recorded.") }
        r.updateMeters()
        peakDB = max(peakDB, Double(r.peakPower(forChannel: 0)))
        let peak = peakDB, muted = inputMute.isInputMuted
        let data: Data = try await withCheckedThrowingContinuation { c in
            stopping = c
            r.stop() // → audioRecorderDidFinishRecording
        }
        #if DEBUG
        let input = AVAudioSession.sharedInstance().currentRoute.inputs.first
        print("pi dictation: peak \(Int(peak)) dB, \(data.count) bytes, muted \(muted), input \(input?.portType.rawValue ?? "none")/\(input?.portName ?? "")")
        #endif
        // Never send silence to be transcribed into nothing: say why instead.
        if let why = Self.silenceMessage(peakDB: peak, stillMuted: muted) { throw DictationError(message: why) }
        return data
    }

    func cancel() {
        guard let r = recorder else { return }
        stopping?.resume(throwing: DictationError(message: "cancelled."))
        stopping = nil
        r.delegate = nil
        r.stop()
        r.deleteRecording()
        teardown()
    }

    nonisolated func audioRecorderDidFinishRecording(_ r: AVAudioRecorder, successfully ok: Bool) {
        let url = r.url
        Task { @MainActor in self.finished(url: url, ok: ok) }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ r: AVAudioRecorder, error: Error?) {
        Task { @MainActor in self.end("Recording failed.") }
    }

    private func finished(url: URL, ok: Bool) {
        let c = stopping
        stopping = nil
        let data = ok ? (try? Data(contentsOf: url)) : nil
        try? FileManager.default.removeItem(at: url)
        teardown()
        if let c {
            if let data { c.resume(returning: data) } else { c.resume(throwing: DictationError(message: "the recording couldn't be read.")) }
        } else {
            onEnded?("Recording stopped.")
        }
    }

    /// The system stopped us: discard and tell the page.
    private func end(_ message: String) {
        guard let r = recorder else { return }
        r.delegate = nil
        r.stop()
        r.deleteRecording()
        stopping?.resume(throwing: DictationError(message: message))
        stopping = nil
        teardown()
        onEnded?(message)
    }

    private func observe() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let began = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            MainActor.assumeIsolated { if began { self?.end("Dictation stopped: another app or a call took the microphone.") } }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            let lost = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
            MainActor.assumeIsolated { if lost { self?.end("Dictation stopped: the microphone was disconnected.") } }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.end("Dictation stopped: audio was reset. Try again.") }
        })
    }

    private func teardown() {
        meter?.invalidate()
        meter = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        recorder = nil
        if AudioOwner.shared.owns(audioToken) { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        audioToken = nil
    }
}
