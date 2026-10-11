import UserNotifications
import XCTest
@testable import Pi

/// The Notification Service Extension's rewrite (PushContent), with the key from `crypto-vectors.json`.
final class PushTests: XCTestCase {
    func vectorKey() throws -> String {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "crypto-vectors", withExtension: "json"))
        return try XCTUnwrap(JSON.parse(Data(contentsOf: url))["key"]?.string)
    }

    /// What `src/apns.ts` `apnsPayload` posts, as iOS hands it to the extension.
    func content(sealed: String, urgent: Bool = false) -> UNNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = "pi"
        c.body = "New activity"
        var aps: [String: Any] = ["alert": ["title": "pi", "body": "New activity"], "mutable-content": 1, "sound": "default"]
        if urgent { aps["interruption-level"] = "time-sensitive" }
        c.userInfo = ["aps": aps, "sealed": sealed]
        return c
    }

    func machines(k: String) -> [Machine] {
        let other = Base64URL.encode(Data(repeating: 9, count: 32))
        return [
            Machine(id: "e-other", machine: "m-other", name: "box", origin: "http://10.0.0.2:7979", d: "d2", k: other, primary: true),
            Machine(id: "e-mac", machine: "m-mac", name: "mac", origin: "http://10.0.0.3:7979", d: "d1", k: k),
        ]
    }

    func testRewritesTitleAndBodyWithTheMachinesKey() throws {
        let k = try vectorKey()
        let sealed = try Envelope.seal(key: XCTUnwrap(Base64URL.decode(k)), value: ["title": "pi-mobile asks", "body": "Run the migration?", "agent": "a1", "machine": "m-mac"])
        let out = PushContent.rewrite(content(sealed: sealed, urgent: true), machines: machines(k: k))
        XCTAssertEqual(out.title, "pi-mobile asks")
        XCTAssertEqual(out.body, "Run the migration?")
        XCTAssertEqual(out.userInfo["agent"] as? String, "a1")
        XCTAssertEqual(out.userInfo["machine"] as? String, "m-mac")
        XCTAssertEqual(out.userInfo["entry"] as? String, "e-mac")
        XCTAssertNil(out.userInfo["sealed"])
        XCTAssertEqual(out.categoryIdentifier, PushContent.asksCategory)
        XCTAssertEqual(out.threadIdentifier, "m-mac:a1")
    }

    func testNotUrgentHasNoVoiceAction() throws {
        let k = try vectorKey()
        let sealed = try Envelope.seal(key: XCTUnwrap(Base64URL.decode(k)), value: ["title": "pi-mobile", "body": "Done", "agent": "a1", "machine": "m-mac"])
        let out = PushContent.rewrite(content(sealed: sealed), machines: machines(k: k))
        XCTAssertEqual(out.body, "Done")
        XCTAssertEqual(out.categoryIdentifier, "")
    }

    /// Each computer is brought in line with its own `apnsOn`, also while off (a missed off is retried).
    func testReconcileAction() {
        let on = PushCenter.action(enabled: true, token: "ab", held: false, sent: false)
        XCTAssertEqual(on?["apns"]?["token"]?.string, "ab")
        XCTAssertNotNil(PushCenter.action(enabled: true, token: "ab", held: true, sent: false), "new token: sent again")
        XCTAssertNil(PushCenter.action(enabled: true, token: "ab", held: true, sent: true))
        XCTAssertEqual(PushCenter.action(enabled: false, token: "ab", held: true, sent: true)?["apns"], .null)
        XCTAssertNil(PushCenter.action(enabled: false, token: "ab", held: false, sent: false))
        XCTAssertNil(PushCenter.action(enabled: true, token: nil, held: false, sent: false), "no token yet")
    }

    func testKeepsGenericTextWhenNoKeyOpensIt() throws {
        let k = try vectorKey()
        let sealed = try Envelope.seal(key: XCTUnwrap(Base64URL.decode(k)), value: ["title": "secret", "body": "secret", "agent": "a1"])
        for list in [[], Array(machines(k: k).prefix(1))] {
            let out = PushContent.rewrite(content(sealed: sealed, urgent: true), machines: list)
            XCTAssertEqual(out.title, "pi")
            XCTAssertEqual(out.body, "New activity")
            XCTAssertEqual(out.categoryIdentifier, "")
            XCTAssertNil(out.userInfo["agent"])
        }
        // Garbled or absent `sealed`.
        XCTAssertEqual(PushContent.rewrite(content(sealed: "nope"), machines: machines(k: k)).body, "New activity")
    }
}
