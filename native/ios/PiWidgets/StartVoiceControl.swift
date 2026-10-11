import AppIntents
import SwiftUI
import WidgetKit

/// Control Center, Lock Screen and Action button: start voice mode without opening the app (D7).
struct StartVoiceControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "dev.pimobile.pi.voice.start") {
            ControlWidgetButton(action: StartVoiceIntent()) {
                Label("Talk to pi", systemImage: "waveform")
            }
        }
        .displayName("Talk to pi")
        .description("Start voice mode with the session that needs you.")
    }
}
