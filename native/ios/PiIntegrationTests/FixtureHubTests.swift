import XCTest
@testable import Pi

/// Against the `npm run ui` fixture hub. Run with `scripts/integration.sh`, which starts the fixture,
/// passes its pairing link as `TEST_RUNNER_PI_PAIR_LINK` and types `ask` into it. Skipped without a link.
final class FixtureHubTests: XCTestCase {
    func testPairCallHubStreamEventsAndAnswerAPrompt() async throws {
        guard let text = ProcessInfo.processInfo.environment["PI_PAIR_LINK"], let link = PairingLink(text) else {
            throw XCTSkip("PI_PAIR_LINK not set; run native/ios/scripts/integration.sh")
        }
        let machine = try await HubClient.pair(link: link, name: "iPhone · pi app (test)")
        let client = try HubClient(machine: machine)
        let hub = try await client.hub()
        XCTAssertFalse(hub.hubId.isEmpty)
        XCTAssertFalse(hub.agents.isEmpty)

        var sawHello = false, sawInfo = false
        var answered: String?
        let deadline = Date().addingTimeInterval(60)
        loop: for try await update in client.events() {
            guard case .event(let ev) = update else { continue }
            switch ev.type {
            case "hello": sawHello = true
            case "info": sawInfo = true
            case "prompt":
                let agent = try XCTUnwrap(ev.agent)
                let id = try XCTUnwrap(ev.raw["prompt"]?["id"]?.string)
                _ = try await client.agent(agent, "answer", ["id": .string(id), "value": true])
                answered = id
            case "prompt_end":
                if let a = answered, ev.raw["id"]?.string == a { break loop }
            default: break
            }
            if Date() > deadline { break }
        }
        XCTAssertTrue(sawHello)
        XCTAssertTrue(sawInfo)
        XCTAssertNotNil(answered, "no prompt arrived: the script types `ask` into the fixture")
    }
}
