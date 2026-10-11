import ActivityKit
import Foundation
import SwiftUI

/// The voice Live Activity (plans/native-apps.md §9). Shared by the app (which starts and updates it from
/// `VoiceActivityController`) and the widget extension (which draws it). Updated locally, never pushed.
struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// `VoiceState.rawValue`; kept as a string so the extension needs no engine types.
        var state: String
        var label: String
        /// When voice mode opened: the elapsed timer is `Text(timerInterval: started...)`, so it ticks without updates.
        var started: Date
        /// pi's open question, only while asking.
        var question: String?
        var muted: Bool
        /// In the content, not the attributes: switching session in voice mode changes the heading.
        var sessionName: String
        /// Shown only while more than one machine is online.
        var machine: String?
    }
}

extension VoiceActivityAttributes.ContentState {
    /// ActivityKit drops updates over 4 KB (attributes + content); stay well under it.
    static let byteBudget = 2048

    /// The state → content mapping (unit tested). `label` is the engine's state word; speaking has none on the
    /// voice screen (the captions say it), so the activity names it. Text is clipped to fit `byteBudget`.
    static func make(state: String, label: String, question: String?, muted: Bool, started: Date,
                     sessionName: String = "pi", machine: String? = nil) -> Self {
        let q = state == "asking" ? question?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        var l = label.isEmpty ? (state == "speaking" ? "pi is speaking" : state.capitalized) : label
        if muted, state != "paused" { l += " · mic off" }
        let name = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        var s = Self(state: state, label: clip(l, 60), started: started, question: q?.isEmpty == false ? clip(q!, 300) : nil,
                     muted: muted, sessionName: clip(name.isEmpty ? "pi" : name, 80), machine: machine.map { clip($0, 40) })
        // Multi-byte text can still be large: shorten the question until the encoded state fits.
        while s.encodedSize > byteBudget, let cur = s.question, cur.count > 1 {
            s.question = clip(cur, cur.count / 2)
        }
        return s
    }

    var encodedSize: Int { (try? JSONEncoder().encode(self).count) ?? .max }

    static func clip(_ s: String, _ n: Int) -> String { s.count <= n ? s : String(s.prefix(max(0, n - 1))) + "…" }

    var title: String { machine.map { "\(sessionName) · \($0)" } ?? sessionName }

    /// The orb's palette (`web/app.css` `.voice[data-state]`, dark tokens): the dot's two stops.
    var palette: (Color, Color) {
        func c(_ hex: UInt32) -> Color { Color(red: Double(hex >> 16 & 255) / 255, green: Double(hex >> 8 & 255) / 255, blue: Double(hex & 255) / 255) }
        if muted { return (c(0x7d8189), c(0x9a9da4)) }
        switch state {
        case "listening", "hearing": return (c(0x6e9bff), c(0x57d0f0))
        case "thinking": return (c(0x6e9bff), c(0xb39bff))
        case "working": return (c(0xb39bff), c(0xe58cf9))
        case "speaking": return (c(0x4fd1c5), c(0x7ee8b5))
        case "asking": return (c(0xf5b84a), c(0xfb923c))
        default: return (c(0x7d8189), c(0x9a9da4))
        }
    }
}
