import XCTest
@testable import Pi

/// Plain HTTP only where `NSAllowsLocalNetworking` lets it through (README → ATS); a clear refusal elsewhere.
final class OriginPolicyTests: XCTestCase {
    func testPlainHTTPOnlyOnYourOwnNetwork() {
        for ok in ["https://box.tail1234.ts.net", "https://example.com:8443", "http://127.0.0.1:7989", "http://localhost:1",
                   "http://10.0.0.2:7777", "http://172.16.0.1", "http://172.31.255.1", "http://192.168.1.20:7777",
                   "http://169.254.3.4", "https://100.101.1.2:7777",
                   "http://mac.local:7777", "http://box:7", "http://[::1]:7", "http://[fe80::1]:7"] {
            XCTAssertNil(OriginPolicy.problem(ok), ok)
        }
        for bad in ["http://example.com", "http://box.tail1234.ts.net", "http://8.8.8.8", "http://172.32.0.1", "http://100.128.0.1",
                    // Tailscale 100.64/10 over plain HTTP: ATS blocks it without NSAllowsArbitraryLoads (checked in the simulator).
                    "http://100.64.0.1", "http://100.101.1.2:7777", "http://[fd7a:115c:a1e0::1]:7", "http://[2001:db8::1]:7"] {
            XCTAssertEqual(OriginPolicy.problem(bad), OriginPolicy.plainHTTPMessage, bad)
        }
        XCTAssertNotNil(OriginPolicy.problem("ftp://box"))
    }

    func testPairingAndClientsRefuseAPublicPlainHTTPAddress() async throws {
        let link = try XCTUnwrap(PairingLink("http://example.com:7777/#p=abc." + Base64URL.encode(Data(repeating: 1, count: 32))))
        do { _ = try await HubClient.pair(link: link, name: "iPhone"); XCTFail() } catch {
            XCTAssertEqual(error as? HubError, .remote(OriginPolicy.plainHTTPMessage))
        }
        let m = Machine(name: "x", origin: "http://example.com", d: "d", k: Base64URL.encode(Data(repeating: 3, count: 32)))
        XCTAssertThrowsError(try HubClient(machine: m))
    }
}
