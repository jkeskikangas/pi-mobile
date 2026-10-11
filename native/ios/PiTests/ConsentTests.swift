import XCTest
@testable import Pi

/// The third-party AI consent gate (App Review 5.1.2(i)).
@MainActor
final class ConsentTests: XCTestCase {
    var defaults: UserDefaults!

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "pi-consent-tests")!
        defaults.removePersistentDomain(forName: "pi-consent-tests")
    }

    func consent(answer: Bool, canAsk: Bool = true, asked: @escaping () -> Void = {}) -> AIConsent {
        let c = AIConsent(defaults: defaults)
        c.ask = { _ in asked(); return answer }
        c.canAsk = { canAsk }
        return c
    }

    func testAllowIsStoredWithItsVersionAndAskedOnce() async throws {
        var asks = 0
        let c = consent(answer: true) { asks += 1 }
        try await c.ensure(.voice)
        try await c.ensure(.dictation)
        XCTAssertEqual(asks, 1)
        XCTAssertEqual(defaults.integer(forKey: AIConsent.key), AIConsent.version)
        // An older version (fewer recipients) asks again.
        defaults.set(AIConsent.version - 1, forKey: AIConsent.key)
        XCTAssertFalse(c.granted)
        try await c.ensure(.voice)
        XCTAssertEqual(asks, 2)
    }

    func testNotNowAndBackgroundThrowAndStoreNothing() async {
        do { try await consent(answer: false).ensure(.voice); XCTFail() } catch { XCTAssertTrue(error is AIConsent.Declined) }
        var asked = false
        do { try await consent(answer: true, canAsk: false) { asked = true }.ensure(.voice); XCTFail() } catch {
            XCTAssertTrue(error is AIConsent.NeedsApp)
        }
        XCTAssertFalse(asked, "never asks while the app isn't on screen")
        XCTAssertFalse(AIConsent(defaults: defaults).granted)
    }

    func testVoiceStartIsGatedBeforeAnyAudio() async throws {
        let store = MachineStore(keychain: Keychain(service: "pi-consent-tests", accessGroup: nil))
        store.clear()
        let m = Machine(id: "a", machine: "mx", name: "Mac", origin: "http://127.0.0.1:9", d: "d", k: Base64URL.encode(Data(repeating: 3, count: 32)), primary: true)
        try store.save([m])
        let model = AppModel(store: store, prefs: VoicePrefs(defaults: defaults))
        let drained = FakeDrain()
        do {
            try await VoiceHost.start(model: model, agent: "ag", machine: "a", dictation: drained, consent: consent(answer: false))
            XCTFail("started without consent")
        } catch {
            XCTAssertTrue(error is AIConsent.Declined)
        }
        XCTAssertFalse(model.voice.isOpen)
        store.clear()
    }

    func testDictationStartIsGated() async {
        let f = FakeRecorder()
        let d = Dictation(recorder: f)
        d.haptic = {}
        d.consent = { throw AIConsent.Declined(purpose: .dictation) }
        do { try await d.start(); XCTFail() } catch { XCTAssertTrue(error is AIConsent.Declined) }
        XCTAssertEqual(d.state, .idle)
    }

    func testCancelWhileTheSheetIsUpGivesTheTakeUp() async {
        let f = FakeRecorder()
        let d = Dictation(recorder: f)
        d.haptic = {}
        var release: CheckedContinuation<Void, Never>?
        d.consent = { await withCheckedContinuation { release = $0 } }
        let start = Task { try await d.start() }
        for _ in 0..<1000 where release == nil { await Task.yield() }
        XCTAssertNotNil(release, "the sheet was not shown")
        d.cancel()
        release?.resume()
        do { try await start.value; XCTFail("started after cancel") } catch {}
        XCTAssertEqual(d.state, .idle)
    }

    func testRevokingDiscardsTheTakeAndEndsVoice() async throws {
        let f = FakeRecorder()
        let d = Dictation(recorder: f)
        d.haptic = {}
        d.consent = {}
        var calls: [String] = []
        d.js = { calls.append($0) }
        let c = consent(answer: true)
        c.grant()
        let model = AppModel(store: MachineStore(keychain: Keychain(service: "pi-consent-tests-3", accessGroup: nil)), prefs: VoicePrefs(defaults: defaults))
        var b = NativeBridge(model: model, primaryOrigin: "http://127.0.0.1:9", dictation: d)
        b.consent = c
        try await d.start()
        _ = await b.handle(["type": "consent.revoke"])
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(f.cancels, 1)
        XCTAssertTrue(calls.contains { $0.contains("dictationEnded") })
        let stop = await b.handle(["type": "dictation.stop"])
        guard case .error = stop else { return XCTFail("audio delivered after revocation") }
    }

    func testOpenVoiceStillNeedsCurrentConsent() async throws {
        let store = MachineStore(keychain: Keychain(service: "pi-consent-tests-4", accessGroup: nil))
        store.clear()
        defer { store.clear() }
        try store.save([Machine(id: "a", name: "Mac", origin: "http://127.0.0.1:9", d: "d", k: Base64URL.encode(Data(repeating: 3, count: 32)), primary: true)])
        let model = AppModel(store: store, prefs: VoicePrefs(defaults: defaults))
        do {
            try await VoiceHost.start(model: model, agent: "ag", machine: "a", dictation: FakeDrain(), consent: consent(answer: false))
            XCTFail()
        } catch { XCTAssertTrue(error is AIConsent.Declined, "consent is checked before the mic or the engine") }
    }

    func testBridgeReportsAndRevokesConsent() async {
        let c = consent(answer: true)
        c.grant()
        let model = AppModel(store: MachineStore(keychain: Keychain(service: "pi-consent-tests-2", accessGroup: nil)), prefs: VoicePrefs(defaults: defaults))
        var b = NativeBridge(model: model, primaryOrigin: "http://127.0.0.1:9")
        b.consent = c
        let s = await b.handle(["type": "consent.status"])
        XCTAssertEqual(s, .value(["granted": true]))
        let r = await b.handle(["type": "consent.revoke"])
        XCTAssertEqual(r, .value(["granted": false]))
        XCTAssertFalse(c.granted)
        XCTAssertTrue(NativeBridge.setupScript(machines: [], prefs: [:]).contains("window.PiNative.consent = true"))
    }
}

@MainActor
private final class FakeDrain: DictationControl {
    func cancelIfActive() async {}
}
