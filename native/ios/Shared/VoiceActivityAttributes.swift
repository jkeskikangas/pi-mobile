import ActivityKit
import Foundation

/// Shared by the app and the widget extension. Filled in by plan Step 7 (Live Activity).
struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String
        var muted: Bool
    }

    var session: String
}
