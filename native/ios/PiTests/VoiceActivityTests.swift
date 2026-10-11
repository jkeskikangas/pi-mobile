import XCTest
@testable import Pi

final class VoiceActivityTests: XCTestCase {
    typealias S = VoiceActivityAttributes.ContentState
    let t0 = Date(timeIntervalSince1970: 1000)

    func testQuestionOnlyWhileAsking() {
        XCTAssertEqual(S.make(state: "asking", label: "pi needs you", question: " Run it? ", muted: false, started: t0).question, "Run it?")
        XCTAssertNil(S.make(state: "working", label: "pi is on it", question: "Run it?", muted: false, started: t0).question)
        XCTAssertNil(S.make(state: "asking", label: "pi needs you", question: "  ", muted: false, started: t0).question)
    }

    func testLabels() {
        XCTAssertEqual(S.make(state: "speaking", label: "", question: nil, muted: false, started: t0).label, "pi is speaking")
        XCTAssertEqual(S.make(state: "listening", label: "Listening", question: nil, muted: true, started: t0).label, "Listening · mic off")
        XCTAssertEqual(S.make(state: "paused", label: "Mic off", question: nil, muted: true, started: t0).label, "Mic off")
        XCTAssertEqual(S.make(state: "working", label: "pi is on it", question: nil, muted: false, started: t0).started, t0)
    }

    func testPaletteFollowsState() {
        let asking = S.make(state: "asking", label: "", question: nil, muted: false, started: t0).palette
        let listening = S.make(state: "listening", label: "", question: nil, muted: false, started: t0).palette
        let muted = S.make(state: "listening", label: "", question: nil, muted: true, started: t0).palette
        let off = S.make(state: "offline", label: "", question: nil, muted: false, started: t0).palette
        XCTAssertNotEqual(asking.0, listening.0)
        XCTAssertEqual(muted.0, off.0)
    }

    @MainActor func testEngineMapping() {
        let e = VoiceEngine()
        let s = VoiceActivityController.content(e, started: t0)
        XCTAssertEqual(s.state, "connecting")
        XCTAssertEqual(s.label, "Connecting…")
        XCTAssertFalse(s.muted)
    }

    func testPickSession() {
        typealias T = VoiceActivityController.Target
        let a = T(agent: "a", machine: "m", name: "A"), b = T(agent: "b", machine: "m", name: "B"), c = T(agent: "c", machine: "n", name: "C")
        XCTAssertEqual(VoiceActivityController.pick([(a, 2), (b, 0), (c, 1)], saved: ["agent": "a", "machine": "m"]), b)
        XCTAssertEqual(VoiceActivityController.pick([(a, 2), (c, 1)], saved: ["agent": "a", "machine": "m"]), a)
        XCTAssertEqual(VoiceActivityController.pick([(a, 2), (c, 1)], saved: nil), c)
        XCTAssertNil(VoiceActivityController.pick([], saved: nil))
    }
}
