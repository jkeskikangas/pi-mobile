import Foundation

/// Voice mode's own connections to every paired machine (plans/native-apps.md §1 "Machines"):
/// one sealed RPC client and one event stream per machine, merged. Separate from the web view's.
@MainActor
final class LiveFleet: VoiceFleet {
    private var clients: [String: HubClient] = [:]
    private var tasks: [Task<Void, Never>] = []
    private var continuation: AsyncStream<FleetUpdate>.Continuation?
    private(set) var machines: [FleetMachine]

    init(machines list: [Machine], session: URLSession = .shared) {
        machines = list.map { FleetMachine(id: $0.id, name: $0.name) }
        for m in list { clients[m.id] = try? HubClient(machine: m, session: session) }
    }

    private func client(_ id: String) throws -> HubClient {
        guard let c = clients[id] else { throw HubError.network("That computer isn't paired with this iPhone.") }
        return c
    }

    func rpc(machine: String, _ m: String, _ p: JSON) async throws -> JSON { try await client(machine).rpc(m, p) }

    func agentCall(machine: String, agent: String, _ m: String, _ p: JSON) async throws -> JSON {
        try await client(machine).agent(agent, m, p)
    }

    func focus(machine: String, agent: String) async { try? await clients[machine]?.focus(agent) }

    func updates() -> AsyncStream<FleetUpdate> {
        AsyncStream { cont in
            self.continuation = cont
            self.open()
            cont.onTermination = { _ in Task { @MainActor in self.close() } }
        }
    }

    func reconnect() {
        close()
        open()
    }

    private func open() {
        guard let cont = continuation else { return }
        for (id, c) in clients {
            let stream = c.events()
            tasks.append(Task {
                do {
                    for try await u in stream {
                        switch u {
                        case .state(let s): cont.yield(.state(machine: id, s))
                        case .event(let e): cont.yield(.event(machine: id, e))
                        }
                    }
                } catch {
                    cont.yield(.state(machine: id, .offline))
                }
            })
        }
    }

    private func close() {
        for t in tasks { t.cancel() }
        tasks = []
    }
}
