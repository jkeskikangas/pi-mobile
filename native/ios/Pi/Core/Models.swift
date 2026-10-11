import Foundation

/// One computer this phone uses (plans/native-apps.md §1 "Machines"). Mirrors the entries
/// `web/fleet.js` keeps: `id` is this phone's own handle, `machine` the computer's id.
struct Machine: Codable, Sendable, Equatable, Identifiable, Hashable {
    var id: String
    var machine: String
    var name: String
    var origin: String
    var d: String
    var k: String
    var primary: Bool
    var added: Double
    var lastSeen: Double

    init(id: String = Machine.newId(), machine: String = "", name: String, origin: String, d: String, k: String, primary: Bool = false, added: Double = Date().timeIntervalSince1970 * 1000, lastSeen: Double = 0) {
        self.id = id; self.machine = machine; self.name = name; self.origin = origin
        self.d = d; self.k = k; self.primary = primary; self.added = added; self.lastSeen = lastSeen
    }

    var key: Data? { Base64URL.decode(k) }
    var url: URL? { URL(string: origin) }

    static func newId() -> String {
        Base64URL.encode(Data((0..<6).map { _ in UInt8.random(in: 0...255) }))
    }

    /// What `web/fleet.js` stores under `pi-mobile-machines` (the primary is reached at the page origin).
    var webEntry: JSON {
        var o: [String: JSON] = ["id": .string(id), "machine": .string(machine), "name": .string(name), "d": .string(d), "k": .string(k), "added": .number(added), "lastSeen": .number(lastSeen)]
        if primary { o["primary"] = true } else { o["origin"] = .string(origin) }
        return .object(o)
    }

    /// The single-device record `web/app.js` reads under `pi-mobile-device`.
    var webDevice: JSON { ["d": .string(d), "k": .string(k), "role": "control", "host": .string(name)] }
}

/// `<origin>/#p=<pairingId>.<base64url key>` from `/remote`.
struct PairingLink: Sendable, Equatable {
    var origin: String
    var id: String
    var key: Data

    init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(percentEncoded: false), let fragment = url.fragment else { return nil }
        guard let m = fragment.firstMatch(of: /(?:^|&)p=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/),
              let key = Base64URL.decode(String(m.2)), key.count == Envelope.keyBytes else { return nil }
        var origin = "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)"
        if let port = url.port { origin += ":\(port)" }
        var path = url.path(percentEncoded: true)
        while path.hasSuffix("/") { path.removeLast() }
        self.origin = origin + path
        self.id = String(m.1)
        self.key = key
    }
}

/// Pair response (`Hub` `/api/pair`).
struct PairResult: Codable, Sendable {
    struct MachineInfo: Codable, Sendable { var id: String; var name: String? }
    var d: String
    var k: String
    var role: String?
    var host: String
    var machine: MachineInfo?
}

/// A pi session as the hub reports it (`src/protocol.ts` AgentInfo); only the fields the app reads.
struct AgentInfo: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String?
    var cwd: String?
    var status: String?
}

/// `hub` RPC result.
struct HubInfo: Sendable {
    var hubId: String
    var host: String
    var seq: Int
    var protocolVersion: Int?
    var features: [String]
    var agents: [JSON]

    init(_ r: JSON) {
        hubId = r["hubId"]?.string ?? ""
        host = r["host"]?.string ?? ""
        seq = r["seq"]?.int ?? 0
        protocolVersion = r["protocol"]?.int
        features = r["features"]?.array?.compactMap(\.string) ?? []
        agents = r["agents"]?.array ?? []
    }
}

/// One event from `/api/stream` (`src/hub.ts` HubEvent / `src/protocol.ts` AgentEvent).
/// Kept as raw JSON: the web UI renders sessions; native code reads only a few fields.
struct HubEvent: Sendable, Equatable {
    var raw: JSON
    var type: String { raw["type"]?.string ?? "" }
    var agent: String? { raw["agent"]?.string }
    var seq: Int? { raw["seq"]?.int }
}

enum HubError: Error, Equatable, LocalizedError {
    /// 401: this phone was removed from that computer.
    case unauthorized
    /// 410 on pairing: the code was used or is older than 10 minutes.
    case expired
    /// The hub answered with an error message.
    case remote(String)
    /// Could not reach the computer, or it answered garbage.
    case network(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "This phone was removed from that computer."
        case .expired: "That code was already used or has expired."
        case .remote(let m): m
        case .network(let m): m
        }
    }
}
