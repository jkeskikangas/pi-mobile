import XCTest

/// End to end in the simulator against the `npm run ui` fixture hub. Run with `scripts/e2e.sh`, which starts
/// the fixture, passes its pairing link as `TEST_RUNNER_PI_PAIR_LINK` and checks the fixture log for the
/// transcribe call afterwards. Skipped without a link. Screenshots land in the test result (and `E2E_SHOTS`).
final class AppE2ETests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        guard let link = ProcessInfo.processInfo.environment["PI_PAIR_LINK"] else {
            throw XCTSkip("PI_PAIR_LINK not set; run native/ios/scripts/e2e.sh")
        }
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-PiReset", "-PiPairLink", link]
        app.launch()
        addUIInterruptionMonitor(withDescription: "permissions") { alert in
            for b in ["Allow", "Allow While Using App", "OK"] where alert.buttons[b].exists { alert.buttons[b].tap(); return true }
            return false
        }
    }

    func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["E2E_SHOTS"] {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testWebVoiceDictationAndNotifications() throws {
        let web = app.webViews.firstMatch
        let voice = web.buttons["Voice mode: talk with pi hands-free"]
        XCTAssertTrue(voice.waitForExistence(timeout: 20), "web UI did not load")
        shot("01-web")

        // Voice: the native screen opens; the fixture has no realtime, so basic voice is used.
        voice.tap()
        // First voice start: the consent sheet names who receives the voice (-PiReset cleared any earlier OK).
        let allow = app.buttons["Allow"]
        if !allow.waitForExistence(timeout: 10) { fail("no consent sheet before voice mode") }
        XCTAssertTrue(app.staticTexts["Where your voice goes"].exists)
        shot("02a-consent")
        allow.tap()
        // A fresh simulator asks for the microphone next (a system alert in SpringBoard).
        let micAlert = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if micAlert.waitForExistence(timeout: 3) { micAlert.tap() }
        let end = app.buttons["End voice mode"]
        if !end.waitForExistence(timeout: 10) {
            shot("02-voice-missing")
            XCTFail("native voice screen did not open:\n\(app.debugDescription)")
        }
        let note = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'basic voice'")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 8), "no basic voice note")
        shot("02-voice-basic")
        end.tap()
        XCTAssertTrue(voice.waitForExistence(timeout: 10), "End did not return to the web UI")
        XCTAssertFalse(end.exists)
        shot("03-after-voice")

        // Dictation: tap to start, wait over a second, tap to stop; the web then calls transcribe.
        let mic = web.switches["Dictate: hold to talk, or tap to start and stop"] // aria-pressed makes it a switch
        if !mic.waitForExistence(timeout: 5) { fail("no mic button") }
        mic.tap()
        sleepRunLoop(1.6) // the take has to be longer than the 600 ms minimum
        shot("04-dictating")
        let finish = web.descendants(matching: .any)["Finish dictation"].firstMatch
        if !finish.exists { fail("not recording") }
        finish.tap()
        let text = web.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS 'round them to cents' OR label CONTAINS 'round them to cents'")).firstMatch
        if !text.waitForExistence(timeout: 10) { fail("no transcription in the composer") }
        shot("05-dictation-done")

        // Hold to talk.
        // The transcription focuses the composer; put the keyboard away so the mic is reachable.
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists { app.toolbars.buttons.allElementsBoundByIndex.last?.tap() }
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keyboard)
        if XCTWaiter.wait(for: [hidden], timeout: 5) != .completed { fail("keyboard still up") }
        if !mic.waitForExistence(timeout: 5) || !mic.isHittable { fail("mic not reachable after the first take") }
        let composer = web.textViews["Message"]
        if !(composer.value as? String ?? "").contains("round them to cents") { fail("distilled text not in the composer") }
        shot("05b-transcribed")
        mic.press(forDuration: 1.6)
        sleepRunLoop(2.5) // the fixture answers transcribe after 1.2 s
        shot("06-hold-done")

        // Notifications row reflects the app's state (push.status).
        web.descendants(matching: .any)["Menu"].firstMatch.tap()
        // The app's answer (push.status), not the web's Home Screen note. This build has no push entitlement
        // (PI_PUSH=NO), so the row says so instead of offering a setup that can't work.
        let pushNote = web.staticTexts.containing(NSPredicate(format: "label CONTAINS 'aren’t available in this build' OR label CONTAINS \"aren't available in this build\"")).firstMatch
        if !pushNote.waitForExistence(timeout: 5) { fail("no push-unavailable note") }
        XCTAssertFalse(web.buttons["Turn on notifications When pi finishes or needs you"].exists)
        XCTAssertFalse(web.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Home Screen'")).firstMatch.exists)
        // Voice sharing was allowed above, so the menu offers to stop it (BRIDGE.md consent.*).
        let revoke = web.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Stop sharing my voice'")).firstMatch
        if !revoke.waitForExistence(timeout: 5) { fail("no consent row in the menu") }
        shot("07-menu-notifications")
    }

    /// Fails with a screenshot and the element tree (also written next to the shots).
    func fail(_ why: String) {
        shot("failed")
        let tree = app.debugDescription
        if let dir = ProcessInfo.processInfo.environment["E2E_SHOTS"] {
            try? tree.write(toFile: dir + "/failed-tree.txt", atomically: true, encoding: .utf8)
        }
        XCTFail("\(why)\n\(tree)")
    }

    /// Waits without blocking the app (screenshots and the recorder keep running).
    func sleepRunLoop(_ s: TimeInterval) { _ = XCTWaiter.wait(for: [expectation(description: "wait")], timeout: s) }
}
