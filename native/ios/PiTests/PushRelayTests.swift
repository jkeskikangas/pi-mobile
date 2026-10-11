import XCTest
@testable import Pi

/// Push through the relay (App Store build): register, hand each computer {url, cap}, re-register when a
/// computer lost it, and take it back on off.
@MainActor
final class PushRelayTests: XCTestCase {
    let relay = URL(string: "https://relay.example.workers.dev")!
    var defaults: UserDefaults!
    var registers: [URLRequest] = []
    var caps = ["cap-1", "cap-2", "cap-3"]

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "pi-relay-tests")!
        defaults.removePersistentDomain(forName: "pi-relay-tests")
        registers = []
        caps = ["cap-1", "cap-2", "cap-3"]
    }

    func center(on: Bool = true) -> PushCenter {
        let c = PushCenter(defaults: defaults)
        c.pushAvailable = true
        c.relay = relay
        c.enabled = on
        c.token = "abcd"
        c.relayRegister = { [unowned self] req in registers.append(req); return caps.removeFirst() }
        return c
    }

    let mac = Machine(id: "e1", name: "mac", origin: "https://mac.tail1.ts.net", d: "d1", k: Base64URL.encode(Data(repeating: 1, count: 32)))
    let box = Machine(id: "e2", name: "box", origin: "https://box.tail1.ts.net", d: "d2", k: Base64URL.encode(Data(repeating: 2, count: 32)))

    /// A computer that answers `hub` with its relay state and records `push` calls.
    final class Hub {
        var relayOn = false
        var apnsOn = false
        var pushes: [JSON] = []
        func rpc(_ m: String, _ p: JSON) -> JSON {
            if m == "hub" { return ["relay": true, "relayOn": .bool(relayOn), "apnsOn": .bool(apnsOn)] }
            pushes.append(p)
            if p["relay"]?.isNull == true { relayOn = false } else if p["relay"] != nil { relayOn = true }
            if p["apns"]?.isNull == true { apnsOn = false }
            return ["ok": true, "relay": true, "relayOn": .bool(relayOn)]
        }
    }

    func run(_ c: PushCenter, _ hubs: [String: Hub]) async {
        await c.reconcile([mac, box]) { m, method, p in hubs[m.id]!.rpc(method, p) }
    }

    func testRegisterRequestShape() throws {
        let req = PushCenter.relayRequest(relay, token: "abcd", sandbox: true)
        XCTAssertEqual(req.url?.absoluteString, "https://relay.example.workers.dev/v1/register")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(try JSON.parse(XCTUnwrap(req.httpBody)), ["platform": "apns", "token": "abcd", "sandbox": true])
        XCTAssertEqual(try PushCenter.relayCap(status: 200, data: Data(#"{"cap":"xyz"}"#.utf8)), "xyz")
        XCTAssertThrowsError(try PushCenter.relayCap(status: 429, data: Data()))
        XCTAssertThrowsError(try PushCenter.relayCap(status: 501, data: Data()))
        XCTAssertNil(PushCenter.relayURL(""))
        XCTAssertNil(PushCenter.relayURL("$(PI_RELAY_URL)"))
        XCTAssertNil(PushCenter.relayURL("http://relay.example"))
        XCTAssertEqual(PushCenter.relayURL("https://relay.example"), URL(string: "https://relay.example"))
    }

    func testEveryComputerGetsTheCapOnceAndAStaleDirectTokenGoes() async {
        let c = center()
        let hubs = ["e1": Hub(), "e2": Hub()]
        hubs["e2"]!.apnsOn = true
        await run(c, hubs)
        XCTAssertEqual(registers.count, 1)
        let sent: JSON = ["relay": ["url": "https://relay.example.workers.dev", "cap": "cap-1"]]
        XCTAssertEqual(hubs["e1"]!.pushes, [sent])
        XCTAssertEqual(hubs["e2"]!.pushes, [["apns": .null], sent])
        await run(c, hubs)
        XCTAssertEqual(hubs["e1"]!.pushes.count, 1, "in line: nothing sent again")
        XCTAssertEqual(registers.count, 1)
    }

    func testAComputerThatLostTheCapTriggersReRegistration() async {
        let c = center()
        let hubs = ["e1": Hub(), "e2": Hub()]
        await run(c, hubs)
        hubs["e1"]!.relayOn = false // the computer dropped it (relay said the cap is gone)
        await run(c, hubs)
        XCTAssertEqual(registers.count, 2)
        XCTAssertEqual(hubs["e1"]!.pushes.last?["relay"]?["cap"], "cap-2")
        await run(c, hubs)
        XCTAssertEqual(hubs["e2"]!.pushes.last?["relay"]?["cap"], "cap-2", "the others follow the new cap")
    }

    func testANewTokenRegistersAgain() async {
        let c = center()
        let hubs = ["e1": Hub(), "e2": Hub()]
        await run(c, hubs)
        c.token = "beef"
        await run(c, hubs)
        XCTAssertEqual(registers.count, 2)
        XCTAssertEqual(try JSON.parse(XCTUnwrap(registers.last?.httpBody))["token"], "beef")
        XCTAssertEqual(hubs["e1"]!.pushes.last?["relay"]?["cap"], "cap-2")
    }

    func testRelayNotConfiguredBacksOffInsteadOfRetrying() async {
        let c = center()
        var t = Date(timeIntervalSince1970: 1_000_000)
        c.now = { t }
        var calls = 0
        c.relayRegister = { _ in calls += 1; throw PushCenter.RelayNotReady() }
        XCTAssertThrowsError(try PushCenter.relayCap(status: 501, data: Data(#"{"error":"apns not configured"}"#.utf8))) { XCTAssertTrue($0 is PushCenter.RelayNotReady) }
        let hubs = ["e1": Hub(), "e2": Hub()]
        for _ in 0..<5 { await run(c, hubs) }
        XCTAssertEqual(calls, 1, "one try, then it waits")
        XCTAssertEqual(hubs["e1"]!.pushes, [], "no cap: nothing sent")
        t += 7 * 3600
        c.relayRegister = { _ in calls += 1; return "cap-ok" }
        await run(c, hubs)
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(hubs["e1"]!.pushes.last?["relay"]?["cap"], "cap-ok")
    }

    func testEachComputerSaysWhetherItWillNotifyAndWhyNot() async {
        let c = center()
        let ok = Hub()
        await c.reconcile([mac, box]) { m, method, p in
            if m.id == "e2" { throw HubError.network("down") }
            return ok.rpc(method, p)
        }
        XCTAssertEqual(c.notifyingCount, 1)
        XCTAssertEqual(c.notifyStatus["e1"], .some(nil))
        XCTAssertEqual(c.notifyStatus["e2"], .some("isn't reachable right now"))
        // An older hub without the relay can't notify, and says so.
        await c.reconcile([mac]) { _, method, p in method == "hub" ? ["relayOn": false] : ok.rpc(method, p) }
        XCTAssertEqual(c.notifyingCount, 0)
        XCTAssertEqual(c.notifyStatus["e1"], .some("runs an older pi-mobile: update it there"))
        // Relay not ready: nothing registered, and the reason is the relay's.
        let d = center()
        d.token = "ffff" // a token without a cap yet
        d.relayRegister = { _ in throw PushCenter.RelayNotReady() }
        await d.reconcile([mac]) { _, method, p in Hub().rpc(method, p) }
        XCTAssertEqual(d.notifyingCount, 0)
        XCTAssertEqual(d.notifyStatus["e1"], .some("Notifications aren't available yet. Try again later."))
    }

    func testOffTakesTheRelayBackFromEveryComputer() async {
        let c = center()
        let hubs = ["e1": Hub(), "e2": Hub()]
        await run(c, hubs)
        c.enabled = false
        await run(c, hubs)
        XCTAssertEqual(hubs["e1"]!.pushes.last, ["relay": .null])
        XCTAssertEqual(hubs["e2"]!.pushes.last, ["relay": .null])
        await run(c, hubs)
        XCTAssertEqual(hubs["e1"]!.pushes.count, 2, "already off: nothing more")
    }
}
