import XCTest
@testable import Pi

/// plans/native-apps.md §7 Tests: VoiceEngine driven by FakeRealtime + FakeHub with the real
/// web/voice-core.js (bundled into the app by the pre-build script).
@MainActor
final class VoiceEngineTests: XCTestCase {
    var hub: FakeHub!
    var rt: FakeRealtime!
    var basic: FakeBasic!
    var earcons: FakeEarcons!
    var clock: ManualScheduler!
    var engine: VoiceEngine!
    var prefs: VoicePrefs!
    var session: FakeAudioSession!

    static func info(_ agent: String, _ name: String, status: String = "idle") -> JSON {
        ["agent": .string(agent), "name": .string(name), "cwd": .string("/src/\(name)"), "status": .string(status)]
    }

    override func setUp() async throws {
        hub = FakeHub([FleetMachine(id: "m1", name: "laptop"), FleetMachine(id: "m2", name: "box")])
        hub.agents = ["m1": [Self.info("a1", "web")], "m2": [Self.info("b1", "api")]]
        hub.reply = { c in
            switch c.m {
            case "voiceSession": return ["sdp": "v=0 answer", "model": "gpt-realtime", "provider": "openai"]
            case "send": return ["delivered": "prompt"]
            case "brief": return ["speech": "Tests pass.", "more": [], "report": "all good"]
            default: return [:]
            }
        }
        rt = FakeRealtime()
        basic = FakeBasic()
        earcons = FakeEarcons()
        clock = ManualScheduler()
        let defaults = UserDefaults(suiteName: "voice-tests-\(UUID().uuidString)")!
        prefs = VoicePrefs(defaults: defaults)
        prefs.set(VoiceEngine.introKey, "1")
        let core = try VoiceCore.bundled()
        session = FakeAudioSession()
        let c = clock!
        engine = VoiceEngine(deps: VoiceDeps(
            fleet: hub, core: core,
            makeRealtime: { [unowned self] in self.rt },
            makeBasic: { [unowned self] in self.basic },
            earcons: earcons, audioSession: session, prefs: prefs, scheduler: c,
            now: { c.now }, ms: { c.t * 1000 }))
    }

    func open() async {
        await engine.start(agent: "a1", machine: "m1")
        await settle()
    }

    // MARK: scenarios

    func testStartsRealtimeThroughTheSessionsMachine() async {
        await open()
        XCTAssertEqual(engine.engineKind, .realtime)
        XCTAssertEqual(engine.state, .listening)
        XCTAssertEqual(hub.calls("voiceSession").first?.machine, "m1")
        XCTAssertEqual(hub.calls("voiceSession").first?.p["sdp"], "v=0 offer")
        XCTAssertTrue(rt.injected.first?.hasPrefix("[PI] Voice mode started.") ?? false)
        XCTAssertEqual(hub.calls("voiceState").last?.p["on"], true)
    }

    func testTwoMachines() async throws {
        await open()
        // Switching to a session on the other machine keeps the call.
        let out = try await engine.tool("switch_session", ["name": "api"])
        XCTAssertEqual(out["switched"], "api on box")
        XCTAssertEqual(engine.machineId, "m2")
        XCTAssertEqual(engine.agent, "b1")
        XCTAssertFalse(rt.closed)
        XCTAssertEqual(engine.engineKind, .realtime)
        // Session calls go to the session's machine, speech calls to the speech machine.
        _ = try await engine.tool("ask_pi", ["request": "run the tests"])
        XCTAssertEqual(hub.calls("send").last?.machine, "m2")
        _ = try await engine.speechCall("voices", [:])
        XCTAssertEqual(hub.calls("voices").last?.machine, "m1")
        // Its machine going down is announced once.
        rt.clear()
        hub.emit(.state(machine: "m2", .offline))
        hub.emit(.state(machine: "m2", .offline))
        await settle()
        XCTAssertEqual(rt.injected.filter { $0.contains("went offline") }.count, 1)
        XCTAssertEqual(earcons.played.filter { $0 == "failed" }.count, 1)
        hub.emit(.state(machine: "m2", .online))
        await settle()
        XCTAssertEqual(rt.injected.filter { $0.contains("is reachable again") }.count, 1)
    }

    func testQuestionGoesToPiAndBriefComesBack() async {
        await open()
        rt.emit(["type": "input_audio_buffer.speech_started"])
        XCTAssertEqual(engine.state, .hearing)
        clock.advance(2)
        rt.emit(["type": "input_audio_buffer.speech_stopped"])
        XCTAssertEqual(engine.state, .thinking)
        rt.emit(["type": "conversation.item.input_audio_transcription.completed", "transcript": "Run the tests and tell me what fails"])
        XCTAssertEqual(engine.heard.text, "Run the tests and tell me what fails")
        rt.emit(["type": "response.created"])
        rt.emit(["type": "response.function_call_arguments.done", "name": "ask_pi", "call_id": "c1", "arguments": #"{"request":"Run the tests and tell me what fails"}"#])
        XCTAssertEqual(rt.types.last, "output_audio_buffer.clear")
        await settle()
        XCTAssertEqual(hub.calls("send").first?.p["text"], "Run the tests and tell me what fails")
        XCTAssertEqual(hub.calls("send").first?.p["mode"], "steer")
        XCTAssertTrue(rt.sent.contains { $0["item"]?["type"] == "function_call_output" && $0["item"]?["call_id"] == "c1" })
        XCTAssertEqual(engine.state, .working)
        rt.emit(["type": "response.done"])
        rt.clear()
        hub.event("m1", ["type": "info", "agent": "a1", "info": Self.info("a1", "web", status: "working")])
        await settle()
        hub.event("m1", ["type": "info", "agent": "a1", "info": Self.info("a1", "web", status: "idle")])
        await settle()
        XCTAssertEqual(hub.calls("brief").first?.machine, "m1")
        XCTAssertTrue(rt.injected.contains { $0.hasPrefix("[PI] pi finished.") && $0.contains("SPOKEN BRIEF: Tests pass.") })
        XCTAssertEqual(rt.types.last, "response.create")
        XCTAssertTrue(earcons.played.contains("done"))
    }

    /// pi speaking with the mic at `level` for `seconds` (20 ms VAD frames).
    func speakingWithMic(_ level: Double, for seconds: Double) {
        rt.micRaw = level
        rt.micLevel = min(1, level.squareRoot() * 1.6)
        clock.advance(seconds)
    }

    func startSpeaking() {
        rt.emit(["type": "response.created"])
        rt.emit(["type": "output_audio_buffer.started"])
        XCTAssertEqual(engine.state, .speaking)
        XCTAssertTrue(rt.sent.contains { $0["type"] == "session.update" && $0["session"]?["audio"]?["input"]?["turn_detection"] == .null })
    }

    func testBackchannelWhileSpeakingDucksButNeverCancels() async {
        await open()
        rt.emit(["type": "session.updated", "session": ["audio": ["input": ["turn_detection": ["type": "semantic_vad"]]]]])
        startSpeaking()
        speakingWithMic(0.2, for: 0.3)
        XCTAssertEqual(rt.remoteVolume, 0.2, "ducked at the first sound")
        speakingWithMic(0, for: 1.0)
        XCTAssertEqual(rt.types.last, "input_audio_buffer.commit")
        XCTAssertEqual(engine.state, .speaking)
        rt.emit(["type": "conversation.item.input_audio_transcription.completed", "transcript": "mm-hmm"])
        XCTAssertEqual(rt.remoteVolume, 1, "unducked")
        XCTAssertEqual(engine.state, .speaking)
        XCTAssertFalse(rt.types.contains("response.cancel"))
        XCTAssertFalse(rt.types.contains("output_audio_buffer.clear"))
        // pi finishes: server turn detection comes back.
        rt.emit(["type": "output_audio_buffer.stopped"])
        XCTAssertEqual(rt.sent.last?["session"]?["audio"]?["input"]?["turn_detection"]?["type"], "semantic_vad")
    }

    func testInterruptionAfterBargeTime() async {
        await open()
        startSpeaking()
        speakingWithMic(0.2, for: 0.5)
        XCTAssertEqual(rt.remoteVolume, 0.2)
        XCTAssertFalse(rt.types.contains("response.cancel"))
        speakingWithMic(0.2, for: 0.6)
        XCTAssertTrue(rt.types.contains("response.cancel"))
        XCTAssertTrue(rt.types.contains("output_audio_buffer.clear"))
        XCTAssertEqual(engine.state, .hearing)
        rt.emit(["type": "response.done"])
        rt.clear()
        speakingWithMic(0, for: 1.0)
        XCTAssertEqual(rt.types, ["input_audio_buffer.commit", "response.create"])
        XCTAssertEqual(engine.state, .thinking)
    }

    func deployPrompt() -> JSON {
        ["id": "p1", "kind": "confirm", "title": "Deploy to production?", "message": "This ships main."]
    }

    func say(_ text: String) {
        rt.emit(["type": "input_audio_buffer.speech_started"])
        clock.advance(2)
        rt.emit(["type": "input_audio_buffer.speech_stopped"])
        rt.emit(["type": "conversation.item.input_audio_transcription.completed", "transcript": .string(text)])
    }

    func testDestructivePromptNamedEarlierGoesAheadAfterGrace() async {
        await open()
        say("deploy the app to production")
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": deployPrompt()])
        await settle()
        XCTAssertNotNil(engine.question?.grace)
        XCTAssertTrue(rt.injected.contains { $0.contains("the phone confirms it in 4 seconds") })
        clock.advance(3.9)
        await settle()
        XCTAssertTrue(hub.calls("answer").isEmpty)
        clock.advance(0.2)
        await settle()
        XCTAssertEqual(hub.calls("answer").first?.p, ["id": "p1", "value": true])
    }

    func testStopWithinGraceAnswersNo() async {
        await open()
        say("deploy the app to production")
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": deployPrompt()])
        await settle()
        clock.advance(1)
        say("stop")
        await settle()
        XCTAssertEqual(hub.calls("answer").first?.p, ["id": "p1", "value": false])
        XCTAssertNil(engine.question?.grace)
        clock.advance(5)
        await settle()
        XCTAssertEqual(hub.calls("answer").count, 1)
        XCTAssertTrue(hub.calls("abort").isEmpty, "stop cancels the confirmation, not pi's work")
    }

    func testBareYeahToDestructivePromptIsRefused() async throws {
        await open()
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": deployPrompt()])
        await settle()
        XCTAssertEqual(engine.state, .asking)
        XCTAssertNil(engine.question?.grace)
        let out = try await engine.tool("answer_question", ["id": "p1", "answer": "yeah"])
        XCTAssertTrue(out["error"]?.string?.contains("yes, deploy") ?? false)
        XCTAssertTrue(hub.calls("answer").isEmpty)
        let ok = try await engine.tool("answer_question", ["id": "p1", "answer": "yes, deploy"])
        XCTAssertEqual(ok["answered"], true)
    }

    func testEchoOfPisWordsNeverCounts() async throws {
        await open()
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": deployPrompt()])
        await settle()
        startSpeaking()
        rt.emit(["type": "response.output_audio_transcript.done", "transcript": "Deploy to production? Say yes, deploy to confirm, or no."])
        // The mic picks pi's own voice up over the speaker.
        speakingWithMic(0.2, for: 0.3)
        speakingWithMic(0, for: 1.0)
        rt.emit(["type": "conversation.item.input_audio_transcription.completed", "transcript": "yes, deploy to confirm"])
        XCTAssertEqual(engine.state, .speaking, "echo is not a turn")
        let out = try await engine.tool("answer_question", ["id": "p1", "answer": "yes, deploy"])
        XCTAssertTrue(out["error"]?.string?.contains("your own voice") ?? false)
        XCTAssertTrue(hub.calls("answer").isEmpty)
        // And it never counts as an earlier request for the undo window.
        XCTAssertFalse(engine.namedEarlier(deployPrompt()))
    }

    func testRealtimeUnavailableFallsBackToBasicVoice() async {
        hub.reply = { c in
            if c.m == "voiceSession" { throw HubError.remote("realtime unavailable: no OpenAI sign-in on this computer") }
            return [:]
        }
        await open()
        XCTAssertEqual(engine.engineKind, .basic)
        XCTAssertTrue(basic.started)
        XCTAssertEqual(engine.note, "Using basic voice. Details in voice settings.")
        XCTAssertEqual(engine.settings.basicReason, "no OpenAI sign-in on this computer")
        // Both machines were tried for speech before giving up.
        XCTAssertEqual(Set(hub.calls("voiceSession").map(\.machine)), ["m1", "m2"])
        clock.advance(8.1)
        XCTAssertEqual(engine.note, "")
    }

    func testSpokenSettingChangesItAndPersists() async {
        await open()
        say("push to talk")
        rt.emit(["type": "response.done"])
        XCTAssertEqual(engine.settings.turns, .tap)
        XCTAssertEqual(prefs.get(VoiceEngine.turnKey), "tap")
        XCTAssertEqual(engine.state, .paused)
        XCTAssertEqual(engine.label, "Push to talk")
        XCTAssertFalse(rt.micEnabled)
        // Hold to talk.
        XCTAssertTrue(engine.pressStart())
        XCTAssertTrue(rt.micEnabled)
        XCTAssertEqual(engine.state, .hearing)
        rt.clear()
        engine.pressEnd(held: true)
        XCTAssertEqual(rt.types, ["input_audio_buffer.commit", "response.create"])
        XCTAssertEqual(engine.state, .thinking)
    }

    func testStopClosesAndReportsVoiceStateOff() async {
        await open()
        var closed = false
        engine.onClose = { closed = true }
        engine.stop()
        await settle()
        XCTAssertTrue(closed)
        XCTAssertTrue(rt.closed)
        XCTAssertFalse(engine.isOpen)
        XCTAssertEqual(hub.calls("voiceState").last?.p["on"], false)
        XCTAssertEqual(earcons.played.last, "off")
        // The "off" earcon plays out before the session is released.
        XCTAssertEqual(session.deactivations, 0)
        clock.advance(0.4)
        XCTAssertEqual(session.deactivations, 1)
        XCTAssertEqual(earcons.stopped, 1)
    }

    // MARK: review regressions

    func startGraceForDeploy(_ id: String = "p1") async {
        say("deploy the app to production")
        rt.emit(["type": "response.done"])
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": ["id": .string(id), "kind": "confirm", "title": "Deploy to production?"]])
        await settle()
        XCTAssertEqual(engine.grace?.prompt["id"]?.string, id)
    }

    func testGraceReplacementAnswersEachWindowOnce() async {
        await open()
        await startGraceForDeploy("p1")
        clock.advance(2)
        hub.event("m1", ["type": "prompt_end", "agent": "a1", "id": "p1", "by": "remote"])
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": ["id": "p2", "kind": "confirm", "title": "Deploy to production?"]])
        await settle()
        XCTAssertEqual(engine.grace?.prompt["id"], "p2")
        // p1's old timer must not fire for p2.
        clock.advance(2.5)
        await settle()
        XCTAssertTrue(hub.calls("answer").isEmpty)
        clock.advance(2)
        await settle()
        XCTAssertEqual(hub.calls("answer").map(\.p), [["id": "p2", "value": true]])
        // A replacement while a window is open cancels the old one (answered no) synchronously.
        await startGraceForDeploy("p3")
        engine.startGrace(["id": "p4", "kind": "confirm", "title": "Deploy to production?"])
        await settle()
        XCTAssertEqual(hub.calls("answer").last?.p, ["id": "p3", "value": false])
        XCTAssertEqual(engine.grace?.prompt["id"], "p4")
    }

    func testInterruptionDropsGraceAndResumes() async {
        await open()
        await startGraceForDeploy()
        session.onInterruption?(true)
        XCTAssertNil(engine.grace)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertFalse(rt.micEnabled)
        clock.advance(5)
        await settle()
        XCTAssertTrue(hub.calls("answer").isEmpty, "no approval while nobody can say stop")
        // Ended without .shouldResume, and the session can't come back yet: stay paused.
        session.onInterruption?(nil)
        session.failActivate = true
        engine.tap()
        XCTAssertEqual(engine.state, .paused)
        XCTAssertFalse(rt.micEnabled)
        session.failActivate = false
        engine.tap()
        XCTAssertEqual(engine.state, .listening)
        XCTAssertTrue(rt.micEnabled)
        // .shouldResume resumes by itself.
        session.onInterruption?(true)
        session.onInterruption?(false)
        XCTAssertEqual(engine.state, .listening)
    }

    func testSystemMuteAtStartAndMuteDropsGrace() async {
        session.isInputMuted = true
        await open()
        XCTAssertTrue(engine.muted)
        XCTAssertEqual(engine.state, .paused)
        XCTAssertFalse(rt.micEnabled)
        session.onInputMute?(false)
        XCTAssertFalse(engine.muted)
        XCTAssertTrue(rt.micEnabled)
        await startGraceForDeploy()
        engine.toggleMute()
        XCTAssertNil(engine.grace)
        XCTAssertTrue(session.isInputMuted)
        clock.advance(5)
        await settle()
        XCTAssertTrue(hub.calls("answer").isEmpty)
    }

    func testRestartForgetsEarlierRequests() async {
        await open()
        say("deploy the app to production")
        engine.stop()
        await settle()
        await open()
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": deployPrompt()])
        await settle()
        XCTAssertNil(engine.grace, "consent from an earlier voice mode never carries over")
        XCTAssertEqual(engine.state, .asking)
    }

    func testOldRequestsExpire() async {
        await open()
        say("deploy the app to production")
        clock.advance(181)
        XCTAssertFalse(engine.namedEarlier(deployPrompt()))
    }

    func testNothingIsSentAfterEnd() async {
        hub.reply = { c in
            if c.m == "voiceSession" { throw HubError.remote("realtime unavailable: off") }
            return ["delivered": "prompt"]
        }
        await open()
        XCTAssertEqual(engine.engineKind, .basic)
        hub.hold = ["distill"]
        let t = Task { await engine.handleUtterance("please run the whole test suite") }
        await settle()
        XCTAssertEqual(hub.calls("distill").first?.machine, "m1", "distill goes to the followed session")
        engine.stop()
        hub.release("distill")
        await t.value
        await settle()
        XCTAssertTrue(hub.calls("send").isEmpty)
        XCTAssertTrue(basic.spoken.isEmpty)
    }

    func testClientVadUsesRawLevelNotDisplayLevel() async {
        await open()
        startSpeaking()
        // Display level looks loud (sqrt-scaled) but the raw RMS is below the over-pi threshold.
        rt.micRaw = 0.02
        rt.micLevel = 0.23
        clock.advance(1)
        XCTAssertEqual(rt.remoteVolume, 1)
        XCTAssertFalse(rt.types.contains("input_audio_buffer.commit"))
    }

    func testDeadSpeechMachineIsRepickedOnce() async throws {
        await open()
        _ = try await engine.tool("switch_session", ["name": "api"])
        hub.reply = { c in
            if c.machine == "m1" { throw HubError.network("Can't reach laptop.") }
            return ["personas": []]
        }
        let before = hub.calls("voices").count
        _ = try await engine.speechCall("voices", [:])
        XCTAssertEqual(hub.calls("voices").dropFirst(before).map(\.machine), ["m1", "m2"])
        XCTAssertEqual(engine.speechMachine, "m2")
        XCTAssertEqual(engine.engineKind, .realtime, "the call stays up")
    }

    func testHeadsetPlayPauseActsLikeATap() async {
        await open()
        startSpeaking()
        rt.clear()
        session.onRemoteToggle?()
        XCTAssertEqual(rt.types, ["response.cancel", "output_audio_buffer.clear"])
        XCTAssertEqual(engine.state, .listening)
        rt.emit(["type": "response.done"])
        hub.event("m1", ["type": "prompt", "agent": "a1", "prompt": ["id": "q", "kind": "confirm", "title": "Run the tests?"]])
        await settle()
        rt.emit(["type": "response.done"])
        rt.clear()
        await engine.answer(VoiceQuestion.Option(label: "Yes", value: true, destructive: false))
        await settle()
        XCTAssertEqual(hub.calls("answer").last?.p, ["id": "q", "value": true])
        XCTAssertFalse(rt.types.contains("response.cancel"), "cancel only while a response is active")
    }
}
