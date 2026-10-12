import XCTest
@testable import Pi

/// The JSContext bridge to web/voice-core.js (the bundled copy, built from web/).
@MainActor
final class VoiceCoreTests: XCTestCase {
    func testLoadsTheBundledCopy() throws {
        let core = try VoiceCore.bundled()
        XCTAssertEqual(core.source, "bundle")
        XCTAssertTrue(core.help.hasPrefix("Just talk to pi"))
        XCTAssertEqual(Set(core.settings), ["pushToTalk", "openMic", "eyesFree", "glance"])
        XCTAssertEqual(core.earcons["listen"], [[880, 70, 0.18]])
    }

    func testDecisions() throws {
        let core = try VoiceCore.bundled()
        XCTAssertEqual(core.parseCommand("hey pi, stop")?.kind, "quiet", "stop is about the voice, never pi's work")
        XCTAssertEqual(core.parseCommand("stop pi")?.kind, "stopPi")
        XCTAssertNil(core.parseCommand("stop the build after the tests run please"))
        let deploy: JSON = ["id": "p", "kind": "confirm", "title": "Deploy to production?"]
        XCTAssertTrue(core.isDestructive(deploy))
        XCTAssertEqual(core.answerFor(prompt: deploy, text: "yeah").needConfirm, "deploy")
        XCTAssertFalse(core.answerFor(prompt: deploy, text: "yeah").answered)
        XCTAssertEqual(core.answerFor(prompt: deploy, text: "yes, deploy").value, true)
        XCTAssertEqual(core.answerFor(prompt: deploy, text: "no").value, false)
        let select: JSON = ["id": "s", "kind": "select", "title": "Which?", "options": ["alpha", "beta"]]
        let cancel = core.answerFor(prompt: select, text: "never mind")
        XCTAssertTrue(cancel.answered)
        XCTAssertNil(cancel.value)
        XCTAssertEqual(core.answerFor(prompt: select, text: "the second one").value, "beta")
        XCTAssertTrue(core.answerFor(prompt: select, text: "purple").unclear)
        XCTAssertTrue(core.requestNames(prompt: deploy, said: "deploy the app to production"))
        XCTAssertFalse(core.requestNames(prompt: deploy, said: "deploy it"))
        XCTAssertTrue(core.isBackchannel("mm-hmm"))
        XCTAssertFalse(core.isBackchannel("yeah", answering: true))
        XCTAssertTrue(core.isEcho("yes deploy", "Say yes, deploy to confirm"))
        XCTAssertTrue(core.isSignificant("git push origin main"))
        XCTAssertTrue(core.incomplete("and then"))
        XCTAssertEqual(core.chunks("One. Two!"), ["One.", "Two!"])
        XCTAssertTrue(core.speakPrompt(deploy).contains(#"Say "yes, deploy" to confirm"#))
    }

    func testMatchSessionAndVad() throws {
        let core = try VoiceCore.bundled()
        let list: [JSON] = [
            ["agent": "m1/a", "name": "api", "cwd": "/x/api", "machine": "laptop"],
            ["agent": "m2/b", "name": "api", "cwd": "/y/api", "machine": "box"],
            ["agent": "m2/c", "name": "web", "cwd": "/y/web", "machine": "box"],
        ]
        XCTAssertEqual(core.matchSession(list, "web"), .match(2))
        XCTAssertEqual(core.matchSession(list, "api"), .ambiguous([0, 1]))
        XCTAssertEqual(core.matchSession(list, "the api on the box"), .match(1))
        XCTAssertEqual(core.matchSession(list, "zebra"), .none)
        let vad = core.vad(hangMs: 800, minSpeechMs: 120)
        var events: [String] = []
        for i in 0..<20 { if let e = vad.feed(0.2, Double(i * 20)) { events.append(e) } }
        for i in 20..<80 { if let e = vad.feed(0, Double(i * 20)) { events.append(e) } }
        XCTAssertEqual(events, ["start", "end"])
    }
}
