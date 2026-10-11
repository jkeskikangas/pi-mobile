import AppIntents

/// Mute or unmute the running voice session (Live Activity button, Shortcuts). Runs in the app process.
struct MuteVoiceIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Mute pi"
    static let description = IntentDescription("Turn the microphone off or on in voice mode.")
    static let isDiscoverable = false

    init() {}

    @MainActor func perform() async throws -> some IntentResult {
        #if !PI_WIDGETS
        VoiceActivityController.shared.engine?.toggleMute()
        #endif
        return .result()
    }
}

/// End voice mode (Live Activity button). The controller ends the activity when the engine closes.
struct EndVoiceIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "End voice mode"
    static let description = IntentDescription("Stop talking to pi.")
    static let isDiscoverable = false

    init() {}

    @MainActor func perform() async throws -> some IntentResult {
        #if !PI_WIDGETS
        VoiceActivityController.shared.end()
        #endif
        return .result()
    }
}
