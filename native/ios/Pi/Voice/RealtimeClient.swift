import Foundation
@preconcurrency import WebRTC

struct RealtimeError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// The OpenAI realtime call over WebRTC (D4): mic track + `oai-events` data channel.
@MainActor
final class RealtimeClient: RealtimeTransport {
    var onEvent: (@MainActor (JSON) -> Void)?
    var onLost: (@MainActor () -> Void)?

    var micEnabled: Bool = true { didSet { localTrack?.isEnabled = micEnabled } }
    /// 1 normal, 0.2 ducked. RTCAudioSource.volume is a gain in [0, 10] with 1 = unity, so it maps
    /// directly. [verify] on device that 1.0 is unity loudness (not 10× quieter).
    var remoteVolume: Double = 1 { didSet { applyRemoteVolume() } }
    var micLevel: Double { levels.mic }
    var piLevel: Double { levels.pi }
    var micRaw: Double { levels.micRaw }

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    private var pc: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var localTrack: RTCAudioTrack?
    private var remoteTrack: RTCAudioTrack?
    private var delegate: Delegate?
    private var channelOpen = false
    private var connected = false
    private var closed = false
    private var openWaiter: CheckedContinuation<Void, Error>?
    private var statsTask: Task<Void, Never>?
    private let levels = Levels()

    init() {}

    func connect(exchange: @escaping @MainActor (String) async throws -> String) async throws {
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let delegate = Delegate(owner: self)
        self.delegate = delegate
        guard let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: delegate) else {
            throw RealtimeError(message: "realtime voice did not connect")
        }
        self.pc = pc

        // Mic. Echo cancellation / NS / AGC come from the VPIO unit (D5). [verify]
        let source = Self.factory.audioSource(with: constraints)
        let track = Self.factory.audioTrack(with: source, trackId: "mic")
        track.isEnabled = micEnabled
        localTrack = track
        pc.add(track, streamIds: ["pi"])

        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        guard let dc = pc.dataChannel(forLabel: "oai-events", configuration: dcConfig) else {
            throw RealtimeError(message: "realtime voice did not connect")
        }
        dc.delegate = delegate
        channel = dc

        let offer = try await createOffer(pc, constraints)
        try await setLocal(pc, offer)
        let answerSDP = try await exchange(offer.sdp)
        if closed { throw RealtimeError(message: "realtime voice did not connect") }
        try await setRemote(pc, RTCSessionDescription(type: .answer, sdp: answerSDP))
        try await waitForOpen()
        startStats()
    }

    func send(_ event: JSON) {
        guard channelOpen, let channel, let data = try? event.data() else { return }
        channel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    func close() {
        guard !closed else { return }
        closed = true
        statsTask?.cancel(); statsTask = nil
        openWaiter?.resume(throwing: RealtimeError(message: "realtime voice did not connect"))
        openWaiter = nil
        channel?.delegate = nil
        channel?.close()
        localTrack?.isEnabled = false
        pc?.close()
        channel = nil; pc = nil; localTrack = nil; remoteTrack = nil; delegate = nil
        channelOpen = false
        levels.reset()
    }

    // MARK: - Offer/answer

    private func createOffer(_ pc: RTCPeerConnection, _ c: RTCMediaConstraints) async throws -> RTCSessionDescription {
        let box: SendableBox<RTCSessionDescription> = try await withCheckedThrowingContinuation { cont in
            pc.offer(for: c) { sdp, error in
                if let sdp { cont.resume(returning: SendableBox(sdp)) }
                else { cont.resume(throwing: error ?? RealtimeError(message: "realtime voice did not connect")) }
            }
        }
        return box.value
    }

    private func setLocal(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    private func setRemote(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    private func waitForOpen() async throws {
        if channelOpen { return }
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, let w = self.openWaiter else { return }
            self.openWaiter = nil
            w.resume(throwing: RealtimeError(message: "realtime voice did not connect"))
        }
        defer { timeout.cancel() }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            if channelOpen { cont.resume() } else { openWaiter = cont }
        }
    }

    // MARK: - Delegate events (already on MainActor)

    fileprivate func channelStateChanged(_ state: RTCDataChannelState) {
        guard !closed else { return }
        switch state {
        case .open:
            channelOpen = true
            openWaiter?.resume(); openWaiter = nil
        case .closing, .closed:
            // The events channel is the call's control: without it the call is lost.
            let was = channelOpen
            channelOpen = false
            if was { onLost?() }
        default: break
        }
    }

    fileprivate func received(_ data: Data) {
        guard !closed, let json = try? JSON.parse(data) else { return }
        onEvent?(json)
    }

    fileprivate func connectionStateChanged(_ state: RTCPeerConnectionState) {
        guard !closed else { return }
        switch state {
        case .connected: connected = true
        case .failed, .closed:
            if connected { connected = false; onLost?() }
        default: break
        }
    }

    fileprivate func remoteTrackAdded(_ track: RTCAudioTrack) {
        guard !closed else { return }
        remoteTrack = track
        applyRemoteVolume()
    }

    private func applyRemoteVolume() {
        remoteTrack?.source.volume = max(0, min(10, remoteVolume))
    }

    // MARK: - Levels

    private func startStats() {
        statsTask?.cancel()
        statsTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, let pc = self.pc else { return }
                let (mic, pi) = await Self.audioLevels(pc)
                if Task.isCancelled || self.closed { return }
                self.levels.update(mic: mic, pi: pi)
            }
        }
    }

    /// `media-source` (kind audio) audioLevel = mic, `inbound-rtp` (kind audio) audioLevel = pi.
    /// [verify] that media-source carries audioLevel for the mic on iOS (older builds only exposed it on `track`).
    private nonisolated static func audioLevels(_ pc: RTCPeerConnection) async -> (Double?, Double?) {
        await withCheckedContinuation { (cont: CheckedContinuation<(Double?, Double?), Never>) in
            pc.statistics { report in
                var mic: Double?, pi: Double?
                for stat in report.statistics.values {
                    let v = stat.values
                    let kind = (v["kind"] as? String) ?? (v["mediaType"] as? String)
                    guard kind == nil || kind == "audio", let level = (v["audioLevel"] as? NSNumber)?.doubleValue else { continue }
                    if stat.type == "media-source" { mic = level }
                    else if stat.type == "inbound-rtp" { pi = level }
                }
                cont.resume(returning: (mic, pi))
            }
        }
    }
}

/// Carries a non-Sendable WebRTC object across the hop to the main actor (WebRTC objects are thread-safe).
private struct SendableBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// WebRTC calls back on its signaling thread; everything hops to the MainActor.
private final class Delegate: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, @unchecked Sendable {
    weak var owner: RealtimeClient?
    init(owner: RealtimeClient) { self.owner = owner }

    private func hop(_ f: @escaping @MainActor (RealtimeClient) -> Void) {
        let ownerBox = SendableBox(self)
        Task { @MainActor in
            if let o = ownerBox.value.owner { f(o) }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        hop { $0.connectionStateChanged(newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track as? RTCAudioTrack else { return }
        let box = SendableBox(track)
        hop { $0.remoteTrackAdded(box.value) }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        let state = dataChannel.readyState
        hop { $0.channelStateChanged(state) }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        hop { $0.received(data) }
    }

    // Unused required callbacks.
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
