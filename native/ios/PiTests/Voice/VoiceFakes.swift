import Foundation
@testable import Pi

/// setTimeout/setInterval on a manual clock.
@MainActor
final class ManualScheduler: VoiceScheduler {
    private struct Item { var id: Int; var at: Double; var every: Double?; var f: @MainActor () -> Void }
    private var items: [Item] = []
    private var nextId = 0
    private(set) var t = 0.0
    let base = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { base.addingTimeInterval(t) }

    func after(_ seconds: Double, _ f: @escaping @MainActor () -> Void) -> VoiceTimer { add(seconds, nil, f) }
    func every(_ seconds: Double, _ f: @escaping @MainActor () -> Void) -> VoiceTimer { add(seconds, seconds, f) }

    private func add(_ s: Double, _ every: Double?, _ f: @escaping @MainActor () -> Void) -> VoiceTimer {
        nextId += 1
        let id = nextId
        items.append(Item(id: id, at: t + s, every: every, f: f))
        return VoiceTimer { [weak self] in MainActor.assumeIsolated { self?.items.removeAll { $0.id == id } } }
    }

    /// Runs every timer due within `seconds`, in time order.
    func advance(_ seconds: Double) {
        let end = t + seconds
        while let i = items.indices.filter({ items[$0].at <= end + 1e-9 }).min(by: { items[$0].at < items[$1].at }) {
            var item = items[i]
            t = max(t, item.at)
            if let e = item.every { item.at += e; items[i] = item } else { items.remove(at: i) }
            item.f()
        }
        t = end
    }
}

@MainActor
final class FakeRealtime: RealtimeTransport {
    var onEvent: (@MainActor (JSON) -> Void)?
    var onLost: (@MainActor () -> Void)?
    var micEnabled = true
    var remoteVolume = 1.0
    var micLevel = 0.0
    var piLevel = 0.0
    var micRaw = 0.0
    private(set) var sent: [JSON] = []
    private(set) var closed = false
    var offerSdp = "v=0 offer"

    func connect(exchange: @escaping @MainActor (String) async throws -> String) async throws {
        _ = try await exchange(offerSdp)
    }
    func send(_ event: JSON) { sent.append(event) }
    func close() { closed = true }

    /// The server sends an event.
    func emit(_ e: JSON) { onEvent?(e) }
    var types: [String] { sent.compactMap { $0["type"]?.string } }
    /// Texts of injected `[PI]` context messages.
    var injected: [String] {
        sent.filter { $0["type"] == "conversation.item.create" && $0["item"]?["type"] == "message" }
            .compactMap { $0["item"]?["content"]?[0]?["text"]?.string }
    }
    func clear() { sent = [] }
}

@MainActor
final class FakeBasic: BasicAudio {
    var started = false
    var spoken: [String] = []
    var ducked = false
    var isSpeaking = false
    var outLevel: Double? { nil }
    func start(onFrame: @escaping @MainActor ([Float], Double) -> Void) throws { started = true }
    func stop() { started = false }
    func play(_ audio: Data, mime: String, done: @escaping @MainActor () -> Void) throws {}
    func speakLocal(_ parts: [String], persona: VoicePersona?, rate: Double, done: @escaping @MainActor () -> Void) { spoken.append(parts.joined(separator: " ")) }
    func silence() {}
    func setDucked(_ d: Bool) { ducked = d }
}

@MainActor
final class FakeEarcons: EarconPlaying {
    var played: [String] = []
    func play(_ name: String) { played.append(name) }
    var stopped = 0
    func stop() { stopped += 1 }
}

@MainActor
final class FakeAudioSession: VoiceAudioSession {
    var route = "Speaker"
    var onInterruption: (@MainActor (Bool?) -> Void)?
    var onRouteChange: (@MainActor (String) -> Void)?
    var onInputMute: (@MainActor (Bool) -> Void)?
    var onNetworkChange: (@MainActor () -> Void)?
    var onRemoteToggle: (@MainActor () -> Void)?
    var isInputMuted = false
    var activeNow = false
    var failActivate = false
    var activations = 0
    var deactivations = 0
    func activate() throws {
        activations += 1
        if failActivate { throw HubError.network("Session activation failed.") }
        activeNow = true
    }
    func deactivate() { deactivations += 1; activeNow = false }
    func setInputMuted(_ muted: Bool) { isInputMuted = muted }
}

/// Machines, sessions and RPCs; records every call.
@MainActor
final class FakeHub: VoiceFleet {
    struct Call: Equatable { var machine: String; var agent: String?; var m: String; var p: JSON }
    var machines: [FleetMachine]
    var agents: [String: [JSON]] = [:]
    var calls: [Call] = []
    /// Per-method replies; throw to fail.
    var reply: (Call) throws -> JSON = { _ in [:] }
    /// Methods whose replies wait for `release`.
    var hold: Set<String> = []
    private var held: [String: [CheckedContinuation<Void, Never>]] = [:]
    func release(_ m: String) {
        hold.remove(m)
        for c in held.removeValue(forKey: m) ?? [] { c.resume() }
    }
    private func wait(_ m: String) async {
        guard hold.contains(m) else { return }
        await withCheckedContinuation { held[m, default: []].append($0) }
    }
    private var cont: AsyncStream<FleetUpdate>.Continuation?

    init(_ machines: [FleetMachine]) { self.machines = machines }

    func rpc(machine: String, _ m: String, _ p: JSON) async throws -> JSON {
        if m == "hub" { return ["agents": .array(agents[machine] ?? [])] }
        let c = Call(machine: machine, agent: nil, m: m, p: p)
        calls.append(c)
        return try reply(c)
    }
    func agentCall(machine: String, agent: String, _ m: String, _ p: JSON) async throws -> JSON {
        let c = Call(machine: machine, agent: agent, m: m, p: p)
        calls.append(c)
        if m == "snapshot" { return ["prompts": []] }
        await wait(m)
        return try reply(c)
    }
    func focus(machine: String, agent: String) async {}
    func updates() -> AsyncStream<FleetUpdate> { AsyncStream { self.cont = $0 } }
    func reconnect() {}

    func emit(_ u: FleetUpdate) { cont?.yield(u) }
    func event(_ machine: String, _ raw: JSON) { emit(.event(machine: machine, HubEvent(raw: raw))) }
    func calls(_ m: String) -> [Call] { calls.filter { $0.m == m } }
}

/// Lets queued main-actor work (Tasks, stream deliveries) run.
@MainActor
func settle() async {
    for _ in 0..<40 { await Task.yield() }
}
