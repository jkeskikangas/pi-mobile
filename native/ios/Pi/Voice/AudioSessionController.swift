import AVFAudio
import Network
@preconcurrency import WebRTC

/// D5 audio session through RTCAudioSession (manual audio), interruptions, routes, input mute (D8)
/// and network path changes.
@MainActor
final class AudioSessionController: VoiceAudioSession {
    var onInterruption: (@MainActor (_ began: Bool?) -> Void)?
    var onRouteChange: (@MainActor (String) -> Void)?
    var onInputMute: (@MainActor (Bool) -> Void)?
    var onNetworkChange: (@MainActor () -> Void)?

    private var observers: [NSObjectProtocol] = []
    private var monitor: NWPathMonitor?
    private var lastPath: String?
    private var active = false

    init() {}

    var route: String { Self.routeName() }

    func activate() throws {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.useManualAudio = true
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.voiceChat.rawValue
        config.categoryOptions = [.allowBluetoothHFP, .defaultToSpeaker]
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        try rtc.setConfiguration(config, active: true)
        rtc.isAudioEnabled = true
        active = true
        observe()
        startPathMonitor()
    }

    func deactivate() {
        guard active else { return }
        active = false
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        monitor?.cancel(); monitor = nil; lastPath = nil
        let rtc = RTCAudioSession.sharedInstance()
        rtc.isAudioEnabled = false
        rtc.lockForConfiguration()
        try? rtc.setActive(false)
        rtc.unlockForConfiguration()
    }

    func setInputMuted(_ muted: Bool) {
        try? AVAudioApplication.shared.setInputMuted(muted)
    }

    // MARK: - Notifications

    private func observe() {
        guard observers.isEmpty else { return }
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { n in
            let info = n.userInfo
            let type = (info?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let opts = AVAudioSession.InterruptionOptions(rawValue: (info?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
            MainActor.assumeIsolated { [weak self] in
                guard let self, let type else { return }
                switch type {
                case .began: self.onInterruption?(true)
                case .ended:
                    if opts.contains(.shouldResume) {
                        // Re-enable WebRTC's audio unit after the interruption. [verify]
                        RTCAudioSession.sharedInstance().isAudioEnabled = true
                        self.onInterruption?(false)
                    } else { self.onInterruption?(nil) }
                @unknown default: break
                }
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { n in
            let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            MainActor.assumeIsolated { [weak self] in
                guard let self else { return }
                if reason == .oldDeviceUnavailable {
                    // AirPods out: keep going on the speaker, never stop. [verify] defaultToSpeaker alone may suffice.
                    let rtc = RTCAudioSession.sharedInstance()
                    rtc.lockForConfiguration()
                    try? rtc.overrideOutputAudioPort(.speaker)
                    rtc.unlockForConfiguration()
                }
                self.onRouteChange?(Self.routeName())
            }
        })
        observers.append(nc.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { n in
            let muted = (n.userInfo?[AVAudioApplication.muteStateKey] as? NSNumber)?.boolValue
            MainActor.assumeIsolated { [weak self] in
                self?.onInputMute?(muted ?? AVAudioApplication.shared.isInputMuted)
            }
        })
        // AVAudioApplication.setInputMuteStateChangeHandler is macOS-only in the SDK; on iOS the AirPods
        // stem press arrives as inputMuteStateChangeNotification. [verify] on device with AirPods.
    }

    private static func routeName() -> String {
        guard let out = AVAudioSession.sharedInstance().currentRoute.outputs.first else { return "" }
        return out.portType == .builtInSpeaker ? "Speaker" : out.portName
    }

    // MARK: - Network

    private func startPathMonitor() {
        guard monitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { path in
            let key: String? = path.status == .satisfied
                ? path.availableInterfaces.map { "\($0.type)-\($0.name)" }.joined(separator: ",")
                : nil
            Task { @MainActor [weak self] in self?.pathChanged(key) }
        }
        m.start(queue: DispatchQueue(label: "pi.voice.path"))
        monitor = m
    }

    /// After the first satisfied path, a different satisfied path → onNetworkChange.
    private func pathChanged(_ key: String?) {
        guard active, let key else { return }
        defer { lastPath = key }
        if let last = lastPath, last != key { onNetworkChange?() }
    }
}
