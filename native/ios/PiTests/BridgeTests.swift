import XCTest
@testable import Pi

@MainActor
final class BridgeTests: XCTestCase {
    var store: MachineStore!
    var defaults: UserDefaults!

    override func setUp() async throws {
        store = MachineStore(keychain: Keychain(service: "pi-mobile-tests", accessGroup: nil))
        store.clear()
        defaults = UserDefaults(suiteName: "pi-tests")!
        defaults.removePersistentDomain(forName: "pi-tests")
    }

    func machine(_ id: String, primary: Bool = false, origin: String = "http://127.0.0.1:9") -> Machine {
        Machine(id: id, machine: "mx-\(id)", name: "Mac \(id)", origin: origin, d: "d-\(id)", k: Base64URL.encode(Data(repeating: 3, count: 32)), primary: primary, added: 1, lastSeen: 2)
    }

    func testMachinesPersistAndMigrateTheSingleDevice() {
        store.save([machine("a", primary: true)])
        XCTAssertEqual(store.load(), [machine("a", primary: true)])
        store.clear()
        store.keychain.set(Data(#"{"origin":"http://h:1","d":"D","k":"K","role":"control","host":"Mac"}"#.utf8), for: MachineStore.legacyAccount)
        let migrated = store.load()
        XCTAssertEqual(migrated.count, 1)
        XCTAssertEqual(migrated.first?.d, "D")
        XCTAssertEqual(migrated.first?.primary, true)
        XCTAssertNil(store.keychain.data(MachineStore.legacyAccount))
    }

    func testSetupScriptInjectsMachinesDeviceAndPrefs() throws {
        let js = NativeBridge.setupScript(machines: [machine("a", primary: true), machine("b", origin: "http://box:1")], prefs: ["pi-mobile-voice-persona": "cedar"])
        XCTAssertTrue(js.contains("pi-mobile-machines"))
        XCTAssertTrue(js.contains(#""origin":"http:\/\/box:1""#) || js.contains(#""origin":"http://box:1""#))
        XCTAssertTrue(js.contains(#""role":"control""#))
        XCTAssertTrue(js.contains("cedar"))
        XCTAssertTrue(js.contains("window.PiNative.version = 1"))
        XCTAssertEqual(machine("a", primary: true).webEntry["origin"], nil, "the primary is reached at the page origin")
    }

    func testPrefsAndStubs() async {
        let model = AppModel(store: store, prefs: VoicePrefs(defaults: defaults))
        let bridge = NativeBridge(model: model, primaryOrigin: "http://127.0.0.1:9")
        let r = await bridge.handle(["type": "prefs", "key": "pi-mobile-voice-persona", "value": "ash"])
        XCTAssertEqual(r, .value(.null))
        XCTAssertEqual(model.prefs.all, ["pi-mobile-voice-persona": "ash"])
        _ = await bridge.handle(["type": "prefs", "key": "something-else", "value": "x"])
        XCTAssertEqual(model.prefs.all.count, 1)
        if case .error = await bridge.handle(["type": "voice.start", "agent": "a", "machine": "m"]) {} else { XCTFail() }
        let cancel = await bridge.handle(["type": "dictation.cancel"])
        XCTAssertEqual(cancel, .value(.null))
    }

    func testMachinesMessageAddsAndKeepsReachableOnes() async {
        let model = AppModel(store: store, prefs: VoicePrefs(defaults: defaults))
        model.session = StubProtocol.session()
        StubProtocol.reset { _, _ in .init(status: 500) } // a computer that does not say 401 keeps its key
        model.added(machine("a", primary: true))
        let bridge = NativeBridge(model: model, primaryOrigin: "http://127.0.0.1:9")
        let entryA = machine("a", primary: true).webEntry
        let entryB = machine("b", origin: "http://box:1").webEntry
        _ = await bridge.handle(["type": "machines", "machines": [entryA, entryB]])
        XCTAssertEqual(model.machines.map(\.id), ["a", "b"])
        XCTAssertEqual(model.machines.first?.origin, "http://127.0.0.1:9")
        _ = await bridge.handle(["type": "machines", "machines": [entryA]])
        XCTAssertEqual(model.machines.map(\.id), ["a", "b"], "kept until confirmed")
        XCTAssertEqual(model.forgetQueue.map(\.id), ["b"])
        model.forget(model.forgetQueue[0])
        XCTAssertEqual(store.load().map(\.id), ["a"])
    }

    func testUnpairedRemovesRevokedComputers() async {
        let model = AppModel(store: store, prefs: VoicePrefs(defaults: defaults))
        model.session = StubProtocol.session()
        StubProtocol.reset { _, _ in .init(status: 401) }
        model.added(machine("a", primary: true))
        _ = await NativeBridge(model: model, primaryOrigin: "http://127.0.0.1:9").handle(["type": "unpaired"])
        XCTAssertNil(model.primary)
        XCTAssertEqual(store.load(), [])
    }
}
