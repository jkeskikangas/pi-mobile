import Foundation

/// Voice mode's own connections to every paired machine (plans/native-apps.md §1 "Machines"):
/// one sealed RPC client and one event stream per machine, merged. Separate from the web view's.
/// Follows the app's machine list while voice mode runs (`setMachines`).
@MainActor
final class LiveFleet: VoiceFleet {
    private var paired: [String: Machine] = [:]
    private var clients: [String: HubClient] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private var continuation: AsyncStream<FleetUpdate>.Continuation?
    private let session: URLSession
    private(set) var machines: [FleetMachine] = []
    /// A machine answered 401: this phone was removed there (AppModel verifies and forgets it).
    var onUnauthorized: (@MainActor (String) -> Void)?

    init(machines list: [Machine], session: URLSession = .shared) {
        self.session = session
        _ = setMachines(list)
    }

    private func client(_ id: String) throws -> HubClient {
        guard let c = clients[id] else { throw HubError.network("That computer isn't paired with this iPhone.") }
        return c
    }

    @discardableResult
    func setMachines(_ list: [Machine]) -> Set<String> {
        var changed: Set<String> = []
        for id in paired.keys where !list.contains(where: { $0.id == id }) {
            tasks.removeValue(forKey: id)?.cancel()
            clients[id] = nil
            paired[id] = nil
        }
        // Only a new credential or address needs a new connection (`lastSeen`/name updates don't).
        for m in list where paired[m.id].map({ $0.d != m.d || $0.k != m.k || $0.origin != m.origin }) ?? true {
            // New or re-paired (new d/k/origin): a fresh client and stream.
            changed.insert(m.id)
            tasks.removeValue(forKey: m.id)?.cancel()
            paired[m.id] = m
            clients[m.id] = try? HubClient(machine: m, session: session)
            if continuation != nil { open(m.id) }
        }
        for m in list { paired[m.id] = m }
        machines = list.map { FleetMachine(id: $0.id, name: $0.name) }
        return changed
    }

    func rpc(machine: String, _ m: String, _ p: JSON) async throws -> JSON { try await client(machine).rpc(m, p) }

    func agentCall(machine: String, agent: String, _ m: String, _ p: JSON) async throws -> JSON {
        try await client(machine).agent(agent, m, p)
    }

    func focus(machine: String, agent: String) async { try? await clients[machine]?.focus(agent) }

    func updates() -> AsyncStream<FleetUpdate> {
        AsyncStream { cont in
            self.continuation = cont
            for id in self.clients.keys { self.open(id) }
            cont.onTermination = { _ in Task { @MainActor in self.close() } }
        }
    }

    func reconnect() {
        let ids = Array(clients.keys)
        close()
        for id in ids { open(id) }
    }

    private func open(_ id: String) {
        guard let cont = continuation, let c = clients[id] else { return }
        let stream = c.events()
        tasks[id]?.cancel()
        tasks[id] = Task { [weak self] in
            do {
                for try await u in stream {
                    switch u {
                    case .state(let s): cont.yield(.state(machine: id, s))
                    case .event(let e): cont.yield(.event(machine: id, e))
                    }
                }
            } catch HubError.unauthorized {
                cont.yield(.state(machine: id, .offline))
                self?.onUnauthorized?(id)
            } catch {
                cont.yield(.state(machine: id, .offline))
            }
        }
    }

    private func close() {
        for t in tasks.values { t.cancel() }
        tasks = [:]
    }
}
