import AppIntents

/// Hands-free start (D7): Live Activity first (Apple requires one for background recording), then the mic.
/// If the activity cannot start headless (locked, iOS refuses), continue in the foreground and retry.
struct StartVoiceIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "Talk to pi"
    static let description = IntentDescription("Start voice mode with the session that needs you, or the one you used last.")
    static let openAppWhenRun = false

    init() {}

    @MainActor func perform() async throws -> some IntentResult {
        #if !PI_WIDGETS
        let c = VoiceActivityController.shared
        guard let target = await c.pickSession() else {
            throw StartVoiceError.noSession
        }
        do {
            try c.startActivity(for: target)
        } catch {
            try await requestToContinueInForeground("Open pi to start voice mode.")
            try c.startActivity(for: target)
        }
        do {
            try await c.startEngine(for: target)
        } catch {
            c.endActivity()
            throw error
        }
        #endif
        return .result()
    }
}

#if !PI_WIDGETS
extension StartVoiceIntent: ForegroundContinuableIntent {}
#endif

enum StartVoiceError: Error, CustomLocalizedStringResourceConvertible {
    case noSession
    var localizedStringResource: LocalizedStringResource { "No pi session is reachable. Run /remote on your computer." }
}
