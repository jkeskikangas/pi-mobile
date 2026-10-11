import SwiftUI

/// The voice screen's colours: the web's vivid dark-palette state colours (`--d-*`), the same in both
/// appearances (`.voice[data-state]` `--c1`/`--c2`), plus the few app tokens the screen uses.
enum VoicePalette {
    static let accent = Color(hex: 0x6E9BFF)      // --d-accent (you)
    static let you2 = Color(hex: 0x57D0F0)        // --d-you-2
    static let busy = Color(hex: 0xB39BFF)        // --d-busy (pi working)
    static let busy2 = Color(hex: 0xE58CF9)       // --d-busy-2
    static let speak = Color(hex: 0x4FD1C5)       // --d-speak
    static let speak2 = Color(hex: 0x7EE8B5)      // --d-speak-2
    static let needs = Color(hex: 0xF5B84A)       // --d-warn-dot (pi needs you)
    static let needs2 = Color(hex: 0xFB923C)      // --d-needs-2
    static let off = Color(hex: 0x7D8189)         // --d-off
    static let offMuted = Color(hex: 0x9A9DA4)    // --d-muted

    /// `--c1`, `--c2` for a state.
    static func pair(_ s: VoiceState) -> (Color, Color) {
        switch s {
        case .listening, .hearing: (accent, you2)
        case .thinking: (accent, busy)
        case .working: (busy, busy2)
        case .speaking: (speak, speak2)
        case .asking: (needs, needs2)
        case .paused, .connecting, .offline: (off, offMuted)
        }
    }

    static func isDim(_ s: VoiceState) -> Bool { s == .paused || s == .connecting || s == .offline }

    /// App tokens that differ by appearance (`--bg`, `--panel-2`, `--fill-2`, `--you`, `--warn`, `--danger`).
    static let panel2 = Color(light: 0xEFEFEB, dark: 0x202226)
    static let fill2 = Color(light: 0xE6E6E1, dark: 0x2A2C31)
    static let surface = Color(light: 0xFFFFFF, dark: 0x17181B)
    static let warnLine = Color(light: 0xF0C98D, dark: 0x5C4318)
    static let warnText = Color(light: 0x8A4F05, dark: 0xF5B84A)
    static let youText = Color(light: 0x2459D6, dark: 0x6E9BFF)
    static let danger = Color(light: 0xC42B2B, dark: 0xC53030)
    static let codeBg = Color(light: 0xF2F2EF, dark: 0x1B1D20)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
    }
}
