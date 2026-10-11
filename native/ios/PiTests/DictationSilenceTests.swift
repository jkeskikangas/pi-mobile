import XCTest
@testable import Pi

/// Issue #3: a muted or blocked microphone records digital silence; dictation unmutes for the take and
/// never sends silence, saying why instead.
@MainActor
final class DictationSilenceTests: XCTestCase {
    final class FakeMute: InputMute {
        var isInputMuted: Bool
        var stuck = false
        var sets: [Bool] = []
        init(_ muted: Bool) { isInputMuted = muted }
        func setInputMuted(_ muted: Bool) throws {
            sets.append(muted)
            if !stuck { isInputMuted = muted }
        }
    }

    func testAMuteLeftByVoiceModeIsLiftedForTheTake() {
        let m = FakeMute(true)
        XCTAssertFalse(AudioRecorder.unmuteForTake(m))
        XCTAssertEqual(m.sets, [false])
        XCTAssertFalse(m.isInputMuted)
    }

    func testAnUnmutedInputIsLeftAlone() {
        let m = FakeMute(false)
        XCTAssertFalse(AudioRecorder.unmuteForTake(m))
        XCTAssertEqual(m.sets, [])
    }

    func testAMuteThatWontLiftIsReported() {
        let m = FakeMute(true)
        m.stuck = true
        XCTAssertTrue(AudioRecorder.unmuteForTake(m))
    }

    func testSilenceIsNamedInsteadOfSent() {
        XCTAssertNil(AudioRecorder.silenceMessage(peakDB: -20, stillMuted: false), "speech")
        XCTAssertNil(AudioRecorder.silenceMessage(peakDB: -75, stillMuted: false), "a quiet room is still a real microphone")
        XCTAssertEqual(AudioRecorder.silenceMessage(peakDB: -160, stillMuted: true), "the microphone is muted for pi. Unmute it (AirPods stem, Control Center or voice mode) and try again.")
        XCTAssertTrue(AudioRecorder.silenceMessage(peakDB: -120, stillMuted: false)?.contains("only silence") == true)
    }
}
