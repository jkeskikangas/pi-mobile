import Foundation
import Synchronization

/// One sealed connection to one computer (plans/native-apps.md §1): RPC plus the event stream.
/// The app keeps one client per machine; no machine relays for another.
actor HubClient {
    enum ConnectionState: Sendable, Equatable { case connecting, online, offline }

    enum Update: Sendable, Equatable {
        case state(ConnectionState)
        case event(HubEvent)
    }

    nonisolated let machine: Machine
    private let key: Data
    private let session: URLSession
    private let clock: @Sendable () -> Date

    /// Reconnect delay doubles from the lower to the upper bound; reset by each `hello`.
    var backoff: ClosedRange<Double> = 0.5...8
    /// The hub pings every 15 s; mobile networks drop sockets silently.
    var stallTimeout: TimeInterval = 40

    private(set) var hubId: String?
    private(set) var seq = 0
    private(set) var clientId: String?
    private(set) var focused = ""
    private var delay: Double = 0.5

    init(machine: Machine, session: URLSession = .shared, clock: @escaping @Sendable () -> Date = Date.init) throws {
        guard let key = machine.key, key.count == Envelope.keyBytes else { throw HubError.network("That computer's key is damaged. Pair it again.") }
        self.machine = machine
        self.key = key
        self.session = session
        self.clock = clock
    }

    func configure(backoff: ClosedRange<Double>? = nil, stallTimeout: TimeInterval? = nil) {
        if let backoff { self.backoff = backoff; delay = backoff.lowerBound }
        if let stallTimeout { self.stallTimeout = stallTimeout }
    }

    private var ms: Double { (clock().timeIntervalSince1970 * 1000).rounded() }

    // MARK: Pairing

    /// Pairs with the computer that showed `link` (single use, 10 min). The result is the primary machine.
    static func pair(link: PairingLink, name: String, session: URLSession = .shared, now: Date = Date()) async throws -> Machine {
        let body: JSON = ["p": .string(link.id), "b": .string(try Envelope.seal(key: link.key, value: ["t": .number((now.timeIntervalSince1970 * 1000).rounded()), "name": .string(name)]))]
        let (status, reply) = try await post(session, "\(link.origin)/api/pair", body)
        switch status {
        case 410: throw HubError.expired
        case 401, 404: throw HubError.remote("That code isn't valid. Run /remote on your computer and scan the new code.")
        default: break
        }
        guard let sealed = reply["b"]?.string else { throw HubError.remote(reply["error"]?.string ?? "Pairing failed (HTTP \(status)).") }
        guard let out = Envelope.open(PairResult.self, key: link.key, sealed: sealed) else { throw HubError.network("The computer's reply could not be read.") }
        return Machine(machine: out.machine?.id ?? "", name: out.host, origin: link.origin, d: out.d, k: out.k, primary: true)
    }

    // MARK: RPC

    func rpc(_ m: String, _ p: JSON = [:]) async throws -> JSON {
        let body: JSON = ["d": .string(machine.d), "b": .string(try Envelope.seal(key: key, value: ["t": .number(ms), "m": .string(m), "p": p]))]
        let (status, reply) = try await Self.post(session, "\(machine.origin)/api/rpc", body)
        if status == 401 { throw HubError.unauthorized }
        guard let sealed = reply["b"]?.string else { throw HubError.remote(reply["error"]?.string ?? "HTTP \(status)") }
        guard let out = Envelope.open(key: key, sealed: sealed) else { throw HubError.network("The computer's reply could not be read.") }
        if let e = out["e"], !e.isNull { throw HubError.remote(e.string ?? "error") }
        return out["r"] ?? .null
    }

    /// Forwards method `m` to one pi session on this computer.
    func agent(_ agent: String, _ m: String, _ p: JSON = [:]) async throws -> JSON {
        try await rpc("agent", ["agent": .string(agent), "m": .string(m), "p": p])
    }

    func hub() async throws -> HubInfo { HubInfo(try await rpc("hub")) }

    /// Detailed events (token stream, tool output) flow only for the focused session. Kept across reconnects.
    func focus(_ agent: String) async throws {
        focused = agent
        guard let clientId else { return }
        _ = try await rpc("focus", ["client": .string(clientId), "agent": .string(agent)])
    }

    private static func post(_ session: URLSession, _ url: String, _ body: JSON) async throws -> (Int, JSON) {
        guard let u = URL(string: url) else { throw HubError.network("That address isn't valid.") }
        var req = URLRequest(url: u, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try body.data()
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) } catch { throw HubError.from(error) }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (status, (try? JSON.parse(data)) ?? [:])
    }

    // MARK: Events

    func streamRequest() throws -> URLRequest {
        var payload: [String: JSON] = ["t": .number(ms), "since": .number(Double(seq))]
        if let hubId { payload["hub"] = .string(hubId) }
        if !focused.isEmpty { payload["focus"] = .string(focused) }
        let b = try Envelope.seal(key: key, value: .object(payload))
        var c = URLComponents(string: "\(machine.origin)/api/stream")
        c?.queryItems = [URLQueryItem(name: "d", value: machine.d), URLQueryItem(name: "b", value: b)]
        guard let url = c?.url else { throw HubError.network("That address isn't valid.") }
        var req = URLRequest(url: url, timeoutInterval: .infinity)
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        return req
    }

    /// The event stream with reconnects (backoff, stall detection, `since` resumption, re-focus after
    /// `hello`). Ends with `HubError.unauthorized` when the phone was removed; otherwise runs until cancelled.
    nonisolated func events() -> AsyncThrowingStream<Update, Error> {
        AsyncThrowingStream { cont in
            let task = Task { await self.run(cont) }
            cont.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ cont: AsyncThrowingStream<Update, Error>.Continuation) async {
        delay = backoff.lowerBound
        while !Task.isCancelled {
            cont.yield(.state(.connecting))
            do {
                try await connectOnce(cont)
            } catch HubError.unauthorized {
                cont.finish(throwing: HubError.unauthorized)
                return
            } catch {}
            if Task.isCancelled { break }
            clientId = nil
            cont.yield(.state(.offline))
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, backoff.upperBound)
        }
        cont.finish()
    }

    private func connectOnce(_ cont: AsyncThrowingStream<Update, Error>.Continuation) async throws {
        let req = try streamRequest()
        let session = session
        let stall = stallTimeout
        let last = Stamp()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                while true {
                    try await Task.sleep(for: .seconds(min(5, stall / 4)))
                    if last.age > stall { throw HubError.network("stalled") }
                }
            }
            group.addTask {
                let (bytes, resp) = try await session.bytes(for: req)
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if status == 401 { throw HubError.unauthorized }
                guard status == 200 else { throw HubError.network("HTTP \(status)") }
                last.touch()
                var parser = SSEParser()
                for try await byte in bytes {
                    guard let item = parser.feed(byte) else { continue }
                    last.touch()
                    if case .message(_, let data) = item { try await self.batch(data, cont) }
                }
                throw HubError.network("closed")
            }
            defer { group.cancelAll() }
            try await group.next()
        }
    }

    private func batch(_ sealed: String, _ cont: AsyncThrowingStream<Update, Error>.Continuation) async throws {
        guard let list = Envelope.open(key: key, sealed: sealed)?.array else { return }
        for raw in list {
            let ev = HubEvent(raw: raw)
            if ev.type == "hello" {
                delay = backoff.lowerBound
                hubId = raw["hubId"]?.string
                seq = raw["seq"]?.int ?? 0
                clientId = raw["client"]?.string
                cont.yield(.state(.online))
                if !focused.isEmpty { try? await focus(focused) }
            } else if let s = ev.seq {
                seq = max(seq, s)
            }
            cont.yield(.event(ev))
        }
    }
}

/// When the stream last delivered anything (data or a ping), shared by the reader and the stall watchdog.
private final class Stamp: Sendable {
    private let at = Mutex(Date())
    func touch() { at.withLock { $0 = Date() } }
    var age: TimeInterval { Date().timeIntervalSince(at.withLock { $0 }) }
}

extension HubError {
    static func from(_ error: Error) -> HubError {
        if let e = error as? HubError { return e }
        if let u = error as? URLError {
            switch u.code {
            case .timedOut: return .network("Your computer didn't answer in time.")
            case .notConnectedToInternet, .networkConnectionLost: return .network("You're offline.")
            default: return .network("Can't reach your computer.")
            }
        }
        return .network(error.localizedDescription)
    }
}
