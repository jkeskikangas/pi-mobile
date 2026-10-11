import SwiftUI
import UIKit

/// Haptics the web can't do outside a gesture: a light tap on press and release, and a pattern on the
/// state changes that matter (pi asks, pi is done, something failed).
@MainActor enum VoiceHaptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let notify = UINotificationFeedbackGenerator()

    static func press() { light.impactOccurred() }
    static func release() { soft.impactOccurred() }
    static func asking() { notify.notificationOccurred(.warning) }
    static func done() { notify.notificationOccurred(.success) }
    static func failed() { notify.notificationOccurred(.error) }
}

private struct VoiceStateHaptics: ViewModifier {
    let engine: VoiceEngine

    func body(content: Content) -> some View {
        content.onChange(of: engine.state) { old, new in
            switch (old, new) {
            case (_, .asking) where old != .asking: VoiceHaptics.asking()
            // pi finished its work and is answering or listening again.
            case (.working, .speaking), (.working, .listening): VoiceHaptics.done()
            case (_, .offline) where old != .offline: VoiceHaptics.failed()
            default: break
            }
        }
    }
}

extension View {
    func voiceHaptics(_ engine: VoiceEngine) -> some View { modifier(VoiceStateHaptics(engine: engine)) }
}
