import AppIntents

struct PiShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartVoiceIntent(),
            phrases: ["Talk to pi in \(.applicationName)", "Ask pi in \(.applicationName)"],
            shortTitle: "Talk to pi",
            systemImageName: "waveform"
        )
    }
}
