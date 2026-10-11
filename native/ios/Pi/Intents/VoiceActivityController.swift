import ActivityKit
import Foundation
import Observation

/// Owns the voice Live Activity: observes `VoiceEngine` (Observation) and starts, updates and ends the
/// activity on every state change (§9). Also what the intents act on, and where the last voice session is kept.
@MainActor
final class VoiceActivityController {
    static let shared = VoiceActivityController()

    struct Target: Equatable { var agent: String; var machine: String; var name: String; var machineName: String? }

    /// The app model, whose `voice` is the one engine (attached by `PiApp` at launch, also for headless intents).
    private(set) var model: AppModel?
    var engine: VoiceEngine? { model?.voice }
    private var activity: Activity<VoiceActivityAttributes>?
    private var started = Date()
    private var last: VoiceActivityAttributes.ContentState?
    private let defaults = UserDefaults.standard
    static let lastKey = "pi-native-voice-last"

    /// Start observing `model.voice`; idempotent.
    func attach(_ m: AppModel) {
        guard model !== m else { return }
        model = m
        observe()
    }

    private func observe() {
        guard let e = engine else { return }
        withObservationTracking {
            _ = (e.isOpen, e.state, e.label, e.question, e.muted, e.sessionName, e.machineName)
        } onChange: { [weak self] in
            Task { @MainActor in self?.observe(); self?.sync() }
        }
    }

    /// Mirror the engine into the activity: start it when voice opens (if the intent did not), update, end on close.
    private func sync() {
        guard let e = engine else { return }
        guard e.isOpen else { endActivity(); return }
        if !e.agent.isEmpty {
            defaults.set(["agent": e.agent, "machine": e.machineId, "name": e.sessionName], forKey: Self.lastKey)
        }
        if activity == nil {
            try? startActivity(for: Target(agent: e.agent, machine: e.machineId, name: e.sessionName, machineName: e.machineName))
        }
        update(Self.content(e, started: started))
    }

    static func content(_ e: VoiceEngine, started: Date) -> VoiceActivityAttributes.ContentState {
        .make(state: e.state.rawValue, label: e.label, question: e.question?.title, muted: e.muted, started: started)
    }

    // MARK: activity

    /// Throws when iOS refuses (activities off, or headless while locked): the intent then continues in the foreground.
    func startActivity(for t: Target, state: VoiceActivityAttributes.ContentState? = nil) throws {
        if activity != nil { return }
        started = Date()
        let s = state ?? .make(state: "connecting", label: "Connecting…", question: nil, muted: false, started: started)
        let attrs = VoiceActivityAttributes(sessionName: t.name.isEmpty ? "pi" : t.name, machine: t.machineName)
        activity = try Activity.request(attributes: attrs, content: .init(state: s, staleDate: nil), pushType: nil)
        last = s
    }

    private func update(_ s: VoiceActivityAttributes.ContentState) {
        guard let a = activity, s != last else { return }
        last = s
        let id = a.id
        Task { await Self.find(id)?.update(.init(state: s, staleDate: nil)) }
    }

    private func endActivity() {
        guard let a = activity else { return }
        activity = nil
        last = nil
        let id = a.id
        Task { await Self.find(id)?.end(nil, dismissalPolicy: .immediate) }
    }

    /// Looked up inside the task: `Activity` is not Sendable.
    nonisolated private static func find(_ id: String) -> Activity<VoiceActivityAttributes>? {
        Activity<VoiceActivityAttributes>.activities.first { $0.id == id }
    }

    /// End voice mode (the End button).
    func end() {
        engine?.stop()
        endActivity()
    }

    func startEngine(for t: Target) async throws {
        guard let model else { throw StartVoiceError.noSession }
        try await VoiceHost.start(model: model, agent: t.agent, machine: t.machine, dictation: nil)
    }

    // MARK: which session (pickAgent() in web/app.js)

    /// The session waiting on you first, else the one voice used last, else the first reachable one.
    func pickSession() async -> Target? {
        guard let model else { return nil }
        var all: [(Target, Int)] = []
        await withTaskGroup(of: [(Target, Int)].self) { g in
            for m in model.machines {
                guard let c = model.client(for: m) else { continue }
                let several = model.machines.count > 1
                g.addTask {
                    guard let info = try? await c.hub() else { return [] }
                    return info.agents.compactMap { a in
                        guard let id = a["agent"]?.string else { return nil }
                        let t = Target(agent: id, machine: m.id, name: a["name"]?.string ?? "", machineName: several ? m.name : nil)
                        return (t, Self.urgency(a["status"]?.string))
                    }
                }
            }
            for await r in g { all += r }
        }
        let saved = defaults.dictionary(forKey: Self.lastKey) as? [String: String]
        return Self.pick(all, saved: saved)
    }

    nonisolated static func urgency(_ status: String?) -> Int { status == "waiting" ? 0 : status == "working" ? 1 : 2 }

    /// Pure choice, unit tested: needs-you beats last-used beats the rest (stable order).
    nonisolated static func pick(_ all: [(Target, Int)], saved: [String: String]?) -> Target? {
        if let t = all.first(where: { $0.1 == 0 }) { return t.0 }
        if let s = saved, let t = all.first(where: { $0.0.agent == s["agent"] && $0.0.machine == s["machine"] }) { return t.0 }
        return all.min { $0.1 < $1.1 }?.0
    }

    // MARK: debug

    /// Debug only: `-PiFakeVoice <state> [-PiFakeMuted]` shows the activity with a fake state (simulator shots).
    func debugFake() async {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-PiFakeVoice"), i + 1 < args.count else { return }
        for a in Activity<VoiceActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
        let state = args[i + 1]
        let labels = ["listening": "Listening", "working": "pi is on it", "asking": "pi needs you", "speaking": "", "paused": "Mic off"]
        let s = VoiceActivityAttributes.ContentState.make(
            state: state, label: labels[state] ?? state, question: "Delete the old build folder and re-run the tests?",
            muted: args.contains("-PiFakeMuted"), started: Date().addingTimeInterval(-83))
        do {
            try startActivity(for: Target(agent: "a", machine: "m", name: "pi-mobile", machineName: args.contains("-PiFakeMachine") ? "studio" : nil), state: s)
            NSLog("PiFakeVoice: activity \(activity?.id ?? "-")")
        } catch {
            NSLog("PiFakeVoice: \(error)")
        }
        #endif
    }
}
