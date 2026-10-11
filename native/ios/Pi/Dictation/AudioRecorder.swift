import AVFoundation

/// AVAudioRecorder: AAC in .m4a, mono, 16 kHz. The session is `.playAndRecord` only while recording.
@MainActor
final class AudioRecorder: NSObject, DictationRecorder, AVAudioRecorderDelegate {
    var onEnded: ((String) -> Void)?
    var onLevel: ((Double) -> Void)?
    private var recorder: AVAudioRecorder?
    private var meter: Timer?
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
                self?.onLevel?(min(1, max(0, (db + 50) / 50)))
            }
        }
    }

    func stop() async throws -> Data {
        guard let r = recorder else { throw DictationError(message: "nothing is being recorded.") }
        return try await withCheckedThrowingContinuation { c in
            stopping = c
            r.stop() // → audioRecorderDidFinishRecording
        }
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
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
