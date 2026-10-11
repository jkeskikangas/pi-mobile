import XCTest
@testable import Pi

/// HTTPS only, plus plain-HTTP loopback for the simulator (README → ATS).
@MainActor
final class OriginPolicyTests: XCTestCase {
    func testHTTPSOnlyExceptLoopback() {
        for ok in ["https://box.tail1234.ts.net", "https://example.com:8443", "https://100.101.1.2:7777",
                   "http://127.0.0.1:7989", "http://localhost:1", "http://[::1]:7"] {
            XCTAssertNil(OriginPolicy.problem(ok), ok)
        }
        for bad in ["http://example.com", "http://box.tail1234.ts.net", "http://10.0.0.2:7777", "http://192.168.1.20:7777",
                    "http://100.101.1.2:7777", "http://mac.local:7777", "http://box:7", "http://[fe80::1]:7"] {
            XCTAssertEqual(OriginPolicy.problem(bad), OriginPolicy.plainHTTPMessage, bad)
        }
        XCTAssertNotNil(OriginPolicy.problem("ftp://box"))
    }

    func testRedirectsStayOnTheSameSecureOrigin() {
        let from = URL(string: "https://box.tail1.ts.net/api/rpc")
        XCTAssertTrue(RedirectGuard.allows(from: from, to: URL(string: "https://box.tail1.ts.net/api/rpc2")))
        XCTAssertFalse(RedirectGuard.allows(from: from, to: URL(string: "http://box.tail1.ts.net/api/rpc")))
        XCTAssertFalse(RedirectGuard.allows(from: from, to: URL(string: "http://mac.local/api/rpc")))
        XCTAssertFalse(RedirectGuard.allows(from: from, to: URL(string: "http://box/api/rpc")))
        XCTAssertFalse(RedirectGuard.allows(from: from, to: URL(string: "https://evil.example/api/rpc")))
        XCTAssertFalse(RedirectGuard.allows(from: from, to: URL(string: "https://box.tail1.ts.net:8443/api/rpc")))
    }

    func testPairingAndClientsRefusePlainHTTP() async throws {
        let link = try XCTUnwrap(PairingLink("http://192.168.1.20:7777/#p=abc." + Base64URL.encode(Data(repeating: 1, count: 32))))
        do { _ = try await HubClient.pair(link: link, name: "iPhone"); XCTFail() } catch {
            XCTAssertEqual(error as? HubError, .remote(OriginPolicy.plainHTTPMessage))
        }
        let m = Machine(name: "x", origin: "http://192.168.1.20:7777", d: "d", k: Base64URL.encode(Data(repeating: 3, count: 32)))
        XCTAssertThrowsError(try HubClient(machine: m))
    }

    func testWebCannotAddAPlainHTTPComputer() async throws {
        let store = MachineStore(keychain: Keychain(service: "pi-origin-tests", accessGroup: nil))
        store.clear()
        defer { store.clear() }
        let key = Base64URL.encode(Data(repeating: 3, count: 32))
        let old = Machine(id: "old", name: "Old", origin: "https://old.tail1.ts.net", d: "d", k: key, primary: true)
        try store.save([old])
        let model = AppModel(store: store, prefs: VoicePrefs(defaults: UserDefaults(suiteName: UUID().uuidString)!))
        let added = Machine(id: "new", name: "New", origin: "http://10.0.0.9:7777", d: "d2", k: key)
        do { try await model.webMachines([old, added]); XCTFail() } catch {
            XCTAssertEqual(error as? HubError, .remote(OriginPolicy.plainHTTPMessage))
        }
        XCTAssertEqual(model.machines.map(\.id), ["old"], "nothing changed")
        let secure = Machine(id: "new", name: "New", origin: "https://new.tail1.ts.net", d: "d2", k: key)
        try await model.webMachines([old, secure])
        XCTAssertEqual(Set(model.machines.map(\.id)), ["old", "new"])
    }
}
