import Foundation
import Observation

/// App state: the computers this phone uses (Keychain), voice preferences, and one hub client per machine.
@MainActor @Observable
final class AppModel {
    private(set) var machines: [Machine]
    /// Computers the page dropped that still accept this phone: the user confirms before the key goes.
    var forgetQueue: [Machine] = []
    let prefs: VoicePrefs
    /// The app's one voice engine (shell, bridge `voice.start`, intents, Live Activity).
    let voice = VoiceEngine()
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
        do { try added(m) } catch {
            throw HubError.remote("Paired, but this iPhone couldn't save the key. Run /remote again and scan the new code.")
        }
    }

    /// Stored first, then shown: a computer only appears once its key is safely in the Keychain.
    func added(_ m: Machine) throws {
        let next = store.adding(m, to: machines)
        try store.save(next)
        machines = next
        PushCenter.shared.machinesChanged()
    }

    /// A Keychain write failed: nothing changed, and the page (which re-sends its list) can retry.
    struct SaveFailed: LocalizedError {
        var errorDescription: String? { "This iPhone couldn't save your computers. Try again." }
    }

    /// Serve the web UI from another computer (the primary one is unreachable). Stored before shown.
    func makePrimary(_ m: Machine) throws {
        var next = machines
        guard next.contains(where: { $0.id == m.id }) else { return }
        for i in next.indices { next[i].primary = next[i].id == m.id }
        do { try store.save(next) } catch { throw SaveFailed() }
        machines = next
        PushCenter.shared.machinesChanged()
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
    /// or the user confirms. Stored before published: on a failed write nothing changes and this throws.
    func webMachines(_ list: [Machine]) async throws {
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
        do { try store.save(next) } catch { throw SaveFailed() }
        machines = next
        PushCenter.shared.machinesChanged()
        try await reconcile(missing)
    }

    func webUnpaired() async throws {
        try await reconcile(machines)
    }

    /// Throws if a removal could not be written (the entry then stays, and the next message retries).
    private func reconcile(_ candidates: [Machine]) async throws {
        var failed = false
        for m in candidates {
            let gone = await revoked(m)
            // The check crossed an await: act only if the stored entry is still the credential we checked
            // (not re-paired or changed meanwhile).
            guard let now = machines.first(where: { $0.id == m.id }), now.origin == m.origin, now.d == m.d, now.k == m.k else { continue }
            if gone { if !remove(now) { failed = true } } else if !forgetQueue.contains(where: { $0.id == now.id }) { forgetQueue.append(now) }
        }
        if failed { throw SaveFailed() }
    }

    private func revoked(_ m: Machine) async -> Bool {
        guard let c = try? HubClient(machine: m, session: session) else { return true }
        do { _ = try await c.hub(); return false } catch HubError.unauthorized { return true } catch { return false }
    }

    func forget(_ m: Machine) {
        forgetQueue.removeAll { $0.id == m.id }
        // Only the credential the user was asked about.
        guard let now = machines.first(where: { $0.id == m.id }), now.d == m.d, now.k == m.k, now.origin == m.origin else { return }
        _ = remove(now) // on a failed write the computer stays; the page's next list asks again
    }

    func keep(_ m: Machine) {
        forgetQueue.removeAll { $0.id == m.id }
    }

    /// Stored first, then published; false (and nothing changed) when the Keychain refuses the write.
    @discardableResult
    private func remove(_ m: Machine) -> Bool {
        var next = machines
        next.removeAll { $0.id == m.id }
        if !next.isEmpty, !next.contains(where: \.primary) { next[0].primary = true }
        guard (try? store.save(next)) != nil else { return false }
        machines = next
        clients[m.id] = nil
        return true
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
