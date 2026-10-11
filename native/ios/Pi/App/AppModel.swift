import Foundation
import Observation

/// App state: the computers this phone uses (Keychain), voice preferences, and one hub client per machine.
@MainActor @Observable
final class AppModel {
    private(set) var machines: [Machine]
    /// Computers the page dropped that still accept this phone: the user confirms before the key goes.
    var forgetQueue: [Machine] = []
    let prefs: VoicePrefs
    @ObservationIgnored private let store: MachineStore
    @ObservationIgnored private var clients: [String: HubClient] = [:]
    @ObservationIgnored var session: URLSession = .shared

    static let deviceName = "iPhone · pi app"

    init(store: MachineStore = MachineStore(), prefs: VoicePrefs = VoicePrefs()) {
        self.store = store
        self.prefs = prefs
        machines = store.load()
    }

    /// The computer that serves the web UI.
    var primary: Machine? { machines.first(where: \.primary) ?? machines.first }

    func pair(_ link: PairingLink) async throws {
        let m = try await HubClient.pair(link: link, name: Self.deviceName, session: session)
        added(m)
    }

    func added(_ m: Machine) {
        machines = store.adding(m, to: machines)
        store.save(machines)
    }

    /// One sealed client per machine; rebuilt when a computer is re-paired.
    func client(for m: Machine) -> HubClient? {
        if let c = clients[m.id], c.machine == m { return c }
        let c = try? HubClient(machine: m, session: session)
        clients[m.id] = c
        return c
    }

    // MARK: The page's list (BRIDGE.md `machines`, `unpaired`)

    /// New or changed entries are stored; a missing one goes only if its computer no longer accepts this phone,
    /// or the user confirms.
    func webMachines(_ list: [Machine]) async {
        var next = machines
        for m in list {
            if let i = next.firstIndex(where: { $0.id == m.id }) { next[i] = m } else { next.append(m) }
        }
        if next.contains(where: \.primary) {
            // Exactly one primary: the page's choice wins.
            let p = list.first(where: \.primary)?.id
            for i in next.indices where p != nil { next[i].primary = next[i].id == p }
        }
        let missing = machines.filter { m in !list.contains { $0.id == m.id } }
        machines = next
        store.save(machines)
        await reconcile(missing)
    }

    func webUnpaired() async {
        await reconcile(machines)
    }

    private func reconcile(_ candidates: [Machine]) async {
        for m in candidates {
            if await revoked(m) { remove(m) } else if !forgetQueue.contains(m) { forgetQueue.append(m) }
        }
    }

    private func revoked(_ m: Machine) async -> Bool {
        guard let c = try? HubClient(machine: m, session: session) else { return true }
        do { _ = try await c.hub(); return false } catch HubError.unauthorized { return true } catch { return false }
    }

    func forget(_ m: Machine) {
        forgetQueue.removeAll { $0.id == m.id }
        remove(m)
    }

    func keep(_ m: Machine) {
        forgetQueue.removeAll { $0.id == m.id }
    }

    private func remove(_ m: Machine) {
        machines.removeAll { $0.id == m.id }
        clients[m.id] = nil
        if !machines.isEmpty, !machines.contains(where: \.primary) { machines[0].primary = true }
        store.save(machines)
    }

    func forgetAll() {
        machines = []
        clients = [:]
        forgetQueue = []
        store.clear()
    }

    /// Debug only: `-PiPairLink <url>` pairs at launch (simulator screenshots, no camera there).
    func debugAutoPair() async {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-PiReset") { forgetAll() }
        if let i = args.firstIndex(of: "-PiPairLink"), i + 1 < args.count, let link = PairingLink(args[i + 1]) {
            try? await pair(link)
        }
        #endif
    }
}

extension Machine {
    /// An entry from the page's list. The primary's `origin` is `""` there (it is the page's own origin).
    init?(web: JSON, primaryOrigin: String) {
        guard let id = web["id"]?.string, let d = web["d"]?.string, let k = web["k"]?.string,
              let key = Base64URL.decode(k), key.count == Envelope.keyBytes else { return nil }
        let primary = web["primary"]?.bool ?? false
        let origin = primary ? primaryOrigin : (web["origin"]?.string ?? "")
        guard !origin.isEmpty else { return nil }
        self.init(id: id, machine: web["machine"]?.string ?? "", name: web["name"]?.string ?? "", origin: origin, d: d, k: k,
                  primary: primary, added: web["added"]?.number ?? 0, lastSeen: web["lastSeen"]?.number ?? 0)
    }
}

/// Voice preferences shared with the web UI, which owns the keys (BRIDGE.md `prefs`).
@MainActor
final class VoicePrefs {
    static let keys = ["pi-mobile-voice-persona", "pi-mobile-voice-attention", "pi-mobile-voice-turns", "pi-mobile-voice-uses", "pi-mobile-voice-intro"]
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func set(_ key: String, _ value: String?) {
        guard Self.keys.contains(key) else { return }
        defaults.set(value, forKey: key)
    }

    func get(_ key: String) -> String? { defaults.string(forKey: key) }

    var all: [String: String] {
        Self.keys.reduce(into: [:]) { out, k in if let v = get(k) { out[k] = v } }
    }
}
