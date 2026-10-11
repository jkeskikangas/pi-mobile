import XCTest
@testable import Pi

@MainActor
final class FakeRecorder: DictationRecorder {
    var onEnded: ((String) -> Void)?
    var onLevel: ((Double) -> Void)?
    var gate: CheckedContinuation<Void, Error>?
    var stopGate: CheckedContinuation<Data, Error>?
    var cancels = 0
    var holdStart = false, holdStop = false
    func start() async throws {
        if holdStart { try await withCheckedThrowingContinuation { gate = $0 } }
    }
    func stop() async throws -> Data {
        if holdStop { return try await withCheckedThrowingContinuation { stopGate = $0 } }
        return Data("m4a".utf8)
    }
    func cancel() {
        cancels += 1
        stopGate?.resume(throwing: DictationError(message: "cancelled.")); stopGate = nil
    }
}

@MainActor
final class DictationTests: XCTestCase {
    func make() -> (Dictation, FakeRecorder, [String]) {
        let f = FakeRecorder()
        let d = Dictation(recorder: f)
        d.haptic = {}
        return (d, f, [])
    }

    func spin() async { for _ in 0..<5 { await Task.yield() } }

    func testStartStopRepliesBase64M4A() async throws {
        let (d, _, _) = make()
        let model = AppModel(store: MachineStore(keychain: Keychain(service: "pi-dictation-tests", accessGroup: nil)), prefs: VoicePrefs(defaults: UserDefaults(suiteName: UUID().uuidString)!))
        let b = NativeBridge(model: model, primaryOrigin: "http://127.0.0.1:9", dictation: d)
        let r1 = await b.handle(["type": "dictation.start"])
        XCTAssertEqual(r1, .value(.null))
        let r2 = await b.handle(["type": "dictation.stop"])
        XCTAssertEqual(r2, .value(["audio": .string(Data("m4a".utf8).base64EncodedString()), "mime": "audio/mp4"]))
        XCTAssertEqual(d.state, .idle)
    }

    func testStopBeforeStartResolvesWaitsForIt() async throws {
        let (d, f, _) = make()
        f.holdStart = true
        let s = Task { try await d.start() }
        await spin()
        let stop = Task { try await d.stop() }
        await spin()
        f.gate?.resume()
        try await s.value
        let data = try await stop.value
        XCTAssertEqual(data, Data("m4a".utf8))
    }

    func testCancelDuringStartDiscardsWhenStartResolves() async throws {
        let (d, f, _) = make()
        f.holdStart = true
        let s = Task { try await d.start() }
        await spin()
        d.cancel()
        f.gate?.resume()
        try await s.value
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(f.cancels, 1)
    }

    func testCancelDuringStopAndDoubleCancel() async throws {
        let (d, f, _) = make()
        f.holdStop = true
        try await d.start()
        let stop = Task { try await d.stop() }
        await spin()
        d.cancel()
        d.cancel()
        do { _ = try await stop.value; XCTFail() } catch {}
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(f.cancels, 1)
        d.cancel() // idle: still fine
        try await d.start() // a fresh take works
        XCTAssertEqual(d.state, .recording)
    }

    func testSystemEndTellsPageAndLevelsFlow() async throws {
        let (d, f, _) = make()
        var sent: [String] = []
        d.js = { sent.append($0) }
        try await d.start()
        f.onLevel?(0.5)
        f.onEnded?("Dictation stopped: the microphone was disconnected.")
        f.onLevel?(0.7)
        XCTAssertEqual(sent.count, 2)
        XCTAssertTrue(sent[0].contains("level(0.500)"))
        XCTAssertTrue(sent[1].contains("dictationEnded(\"Dictation stopped: the microphone was disconnected.\")"))
        XCTAssertEqual(d.state, .idle)
        d.cancelIfActive()
        XCTAssertEqual(f.cancels, 0)
    }
}
