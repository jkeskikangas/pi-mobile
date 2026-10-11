import XCTest
@testable import Pi

final class HubClientTests: XCTestCase {
    let key = Data((0..<32).map { UInt8($0 + 7) })
    let pairKey = Data((0..<32).map { UInt8(200 - $0) })
    var machine: Machine { Machine(id: "m1", name: "Laptop", origin: "https://box.tail1.ts.net:7979", d: "dev1", k: Base64URL.encode(key), primary: true) }

    func json(_ v: JSON) -> Data { try! v.data() }

    func testPairingLinkParsing() throws {
        let k = Base64URL.encode(pairKey)
        let l = try XCTUnwrap(PairingLink("  http://192.168.1.4:7979/#p=abc_-1.\(k)\n"))
        XCTAssertEqual(l.origin, "http://192.168.1.4:7979")
        XCTAssertEqual(l.id, "abc_-1")
        XCTAssertEqual(l.key, pairKey)
        XCTAssertEqual(PairingLink("https://mac.tail1.ts.net/pi/#x=1&p=id.\(k)")?.origin, "https://mac.tail1.ts.net/pi")
        XCTAssertNil(PairingLink("http://h/#p=id.short"))
        XCTAssertNil(PairingLink("ftp://h/#p=id.\(k)"))
        XCTAssertNil(PairingLink("hello"))
    }

    func testPairRequestShapeAndResult() async throws {
        let pk = pairKey
        StubProtocol.reset { req, body in
            let reply = try! Envelope.seal(key: pk, value: ["d": "dev9", "k": .string(Base64URL.encode(Data(repeating: 1, count: 32))), "role": "control", "host": "MacBook Pro", "machine": ["id": "fx-laptop", "name": "MacBook Pro"]])
            return .init(body: try! JSON.object(["b": .string(reply)]).data())
        }
        let link = try XCTUnwrap(PairingLink("http://127.0.0.1:7979/#p=pid.\(Base64URL.encode(pairKey))"))
        let m = try await HubClient.pair(link: link, name: "iPhone · pi app", session: StubProtocol.session(), now: Date(timeIntervalSince1970: 1_760_000_000))
        XCTAssertEqual(m.d, "dev9")
        XCTAssertEqual(m.name, "MacBook Pro")
        XCTAssertEqual(m.machine, "fx-laptop")
        XCTAssertEqual(m.origin, "http://127.0.0.1:7979")
        XCTAssertTrue(m.primary)

        let (req, body) = try XCTUnwrap(StubProtocol.recorded.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "http://127.0.0.1:7979/api/pair")
        XCTAssertEqual(req.value(forHTTPHeaderField: "content-type"), "application/json")
        let sent = try JSON.parse(body)
        XCTAssertEqual(sent["p"], "pid")
        let inner = try XCTUnwrap(Envelope.open(key: pairKey, sealed: try XCTUnwrap(sent["b"]?.string)))
        XCTAssertEqual(inner, ["t": 1_760_000_000_000, "name": "iPhone · pi app"])
    }

    func testPairExpiredCode() async throws {
        StubProtocol.reset { _, _ in .init(status: 410, body: Data(#"{"error":"pairing expired"}"#.utf8)) }
        let link = try XCTUnwrap(PairingLink("https://h:1/#p=pid.\(Base64URL.encode(pairKey))"))
        do { _ = try await HubClient.pair(link: link, name: "x", session: StubProtocol.session()); XCTFail() } catch { XCTAssertEqual(error as? HubError, .expired) }
    }

    func testRpcShapeResultAndErrors() async throws {
        let k = key
        var reply: JSON = ["r": ["hubId": "h1", "host": "Laptop", "seq": 3, "protocol": 2, "features": ["voice"], "agents": []]]
        var status = 200
        StubProtocol.reset { _, _ in .init(status: status, body: try! JSON.object(["b": .string(try! Envelope.seal(key: k, value: reply))]).data()) }
        let c = try HubClient(machine: machine, session: StubProtocol.session(), clock: { Date(timeIntervalSince1970: 1000) })
        let info = try await c.hub()
        XCTAssertEqual(info.hubId, "h1")
        XCTAssertEqual(info.protocolVersion, 2)
        XCTAssertEqual(info.features, ["voice"])

        let (req, body) = try XCTUnwrap(StubProtocol.recorded.last)
        XCTAssertEqual(req.url?.absoluteString, "https://box.tail1.ts.net:7979/api/rpc")
        let sent = try JSON.parse(body)
        XCTAssertEqual(sent["d"], "dev1")
        XCTAssertEqual(Envelope.open(key: key, sealed: try XCTUnwrap(sent["b"]?.string)), ["t": 1_000_000, "m": "hub", "p": [:]])

        _ = try? await c.agent("a1", "send", ["text": "hi", "mode": "steer"])
        let agentBody = try JSON.parse(StubProtocol.recorded.last!.1)
        XCTAssertEqual(Envelope.open(key: key, sealed: agentBody["b"]!.string!)?["p"], ["agent": "a1", "m": "send", "p": ["text": "hi", "mode": "steer"]])

        reply = ["e": "unknown method"]
        do { _ = try await c.rpc("nope"); XCTFail() } catch { XCTAssertEqual(error as? HubError, .remote("unknown method")) }
        status = 401
        do { _ = try await c.rpc("hub"); XCTFail() } catch { XCTAssertEqual(error as? HubError, .unauthorized) }
    }

    func testStreamRequestCarriesResumeState() async throws {
        let c = try HubClient(machine: machine, clock: { Date(timeIntervalSince1970: 2) })
        try await c.focus("agentA") // no client id yet: remembered, sent with the next connect
        let req = try await c.streamRequest()
        let q = try XCTUnwrap(URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(req.url?.path(), "/api/stream")
        XCTAssertEqual(q.first { $0.name == "d" }?.value, "dev1")
        let b = try XCTUnwrap(q.first { $0.name == "b" }?.value)
        XCTAssertEqual(Envelope.open(key: key, sealed: b), ["t": 2000, "since": 0, "focus": "agentA"])
    }

    func testEventsDecodeBatchesTrackHelloAndReconnect() async throws {
        let k = key
        let hello = try Envelope.seal(key: k, value: [["type": "hello", "hubId": "H", "seq": 5, "resync": true, "client": "c1"], ["type": "info", "agent": "a1", "seq": 6, "info": [:]]])
        StubProtocol.reset { req, _ in
            if req.url?.path() == "/api/stream" {
                // Split mid-line: the parser must not care.
                let text = ": ping\n\ndata: \(hello)\n\n"
                let bytes = Data(text.utf8)
                return .init(chunks: [bytes.prefix(20), bytes.dropFirst(20)])
            }
            return .init(body: try! JSON.object(["b": .string(try! Envelope.seal(key: k, value: ["r": true]))]).data())
        }
        let c = try HubClient(machine: machine, session: StubProtocol.session())
        await c.configure(backoff: 0.01...0.02)
        try await c.focus("a1")
        var seen: [HubClient.Update] = []
        for try await u in c.events() {
            seen.append(u)
            if seen.filter({ $0 == .state(.offline) }).count == 1 { break }
        }
        XCTAssertEqual(seen.first, .state(.connecting))
        XCTAssertTrue(seen.contains(.state(.online)))
        XCTAssertEqual(seen.compactMap { if case .event(let e) = $0 { e.type } else { nil } }, ["hello", "info"])
        let hubId = await c.hubId
        let seq = await c.seq
        XCTAssertEqual(hubId, "H")
        XCTAssertEqual(seq, 6)
        // Re-focused after hello.
        let focusCalls = StubProtocol.recorded.filter { $0.0.url?.path() == "/api/rpc" }.compactMap { Envelope.open(key: k, sealed: try! JSON.parse($0.1)["b"]!.string!) }
        XCTAssertTrue(focusCalls.contains { $0["m"] == "focus" && $0["p"] == ["client": "c1", "agent": "a1"] })
    }

    func testEventsEndOnUnauthorized() async throws {
        StubProtocol.reset { _, _ in .init(status: 401) }
        let c = try HubClient(machine: machine, session: StubProtocol.session())
        do {
            for try await _ in c.events() {}
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? HubError, .unauthorized)
        }
    }

    func testStallReconnects() async throws {
        // A stream that sends headers and then nothing: the stall watchdog must give up on it.
        let c = try HubClient(machine: machine, session: HangingSession.make())
        await c.configure(backoff: 0.01...0.02, stallTimeout: 0.3)
        let start = Date()
        for try await u in c.events() where u == .state(.offline) { break }
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
    }
}

/// A protocol that answers 200 and never sends a byte.
final class HangingProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
    }
    override func stopLoading() {}
}

enum HangingSession {
    static func make() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [HangingProtocol.self]
        return URLSession(configuration: c)
    }
}
