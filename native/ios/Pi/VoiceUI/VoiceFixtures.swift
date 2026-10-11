#if DEBUG
import SwiftUI

/// Voice screen states for previews and the UI snapshots (no audio, no hub).
enum VoiceFixtures {
    static let personas = [
        VoicePersona(id: "marin", name: "Marin", blurb: "Warm and clear", rate: 1, phonePrefer: ["Samantha"], phonePitch: 1),
        VoicePersona(id: "cedar", name: "Cedar", blurb: "Calm, lower", rate: 0.95, phonePrefer: ["Daniel"], phonePitch: 0.9),
        VoicePersona(id: "sage", name: "Sage", blurb: "Brisk and bright", rate: 1.08, phonePrefer: ["Karen"], phonePitch: 1.05),
    ]
    static let sessions = [
        VoiceSessionItem(agent: "a1", machine: "m1", name: "pi-mobile", machineName: nil, status: "working", waiting: 0),
        VoiceSessionItem(agent: "a2", machine: "m1", name: "website", machineName: nil, status: "idle", waiting: 1),
        VoiceSessionItem(agent: "a3", machine: "m1", name: "infra", machineName: nil, status: "idle", waiting: 0),
    ]

    /// Every state the snapshots cover, by name.
    static let names = ["connecting", "listening", "hearing", "thinking", "working", "speaking", "asking", "select", "grace", "paused", "muted", "ptt", "offline"]

    @MainActor static func engine(_ name: String) -> VoiceEngine {
        let e = VoiceEngine()
        let now = Date()
        var settings = VoiceSettings(personas: personas)
        if name == "ptt" || name == "paused" { settings.turns = .tap }
        e.preview(state: .listening, engineKind: .realtime, sessionName: "pi-mobile", sessionLine: "Idle", sessionStatus: "idle",
                  settings: settings, sessions: sessions, uses: 3, now: now)
        switch name {
        case "connecting": e.preview(state: .connecting, engineKind: .some(nil))
        case "listening": e.preview(state: .listening, uses: 1)
        case "hearing": e.preview(state: .hearing, heard: VoiceCaption(text: "Is the build green and can you run the tests on the simulator", live: true))
        case "thinking": e.preview(state: .thinking, heard: VoiceCaption(text: "Is the build green?"))
        case "working":
            e.preview(state: .working, heard: VoiceCaption(text: "Run the tests and tell me what fails."), said: VoiceCaption(text: "On it. I'll run the tests now."),
                      sessionLine: "Working · 0:42", sessionStatus: "working", workingSince: now.addingTimeInterval(-42))
        case "speaking":
            e.preview(state: .speaking, heard: VoiceCaption(text: "What's it doing?"),
                      said: VoiceCaption(text: "The tests pass. I changed the voice screen's header and the change is ready for you to review.", live: true))
        case "asking":
            e.preview(state: .asking, said: VoiceCaption(text: "Delete the old build folder?"), question: .some(VoiceQuestion(
                id: "q1", kind: "confirm", title: "Delete the old build folder?", message: "rm -rf native/ios/build", destructive: true,
                options: [.init(label: "Yes, do it", value: .bool(true), destructive: true), .init(label: "No", value: .bool(false), destructive: false)])),
                      sessionLine: "Needs you · Delete the old build folder?", sessionStatus: "waiting")
        case "select":
            e.preview(state: .asking, question: .some(VoiceQuestion(
                id: "q2", kind: "select", title: "Which branch should I push to?", message: nil, destructive: false,
                options: [.init(label: "main", value: .string("main"), destructive: false), .init(label: "voice-ui", value: .string("voice-ui"), destructive: false),
                          .init(label: "Force-push main", value: .string("Force-push main"), destructive: true), .init(label: "Cancel", value: nil, destructive: false, ghost: true)])),
                      sessionLine: "Needs you · Which branch?", sessionStatus: "waiting")
        case "grace":
            e.preview(state: .asking, question: .some(VoiceQuestion(
                id: "q1", kind: "confirm", title: "Delete the old build folder?", message: nil, destructive: true, options: [],
                grace: .init(until: now.addingTimeInterval(3), total: 5))), sessionLine: "Needs you", sessionStatus: "waiting")
        case "paused": e.preview(state: .paused)
        case "muted": e.preview(state: .paused, muted: true)
        case "ptt": e.preview(state: .hearing, heard: VoiceCaption(text: "Push the branch", live: true), talking: true, holding: true)
        case "offline": e.preview(state: .offline, note: "Lost the connection to your computer. Trying again…")
        default: break
        }
        e.levels = VoiceLevels(mine: name == "hearing" || name == "ptt" ? 0.55 : 0.1, pi: name == "speaking" ? 0.5 : 0)
        return e
    }
}

#Preview("Listening") { VoiceScreen(engine: VoiceFixtures.engine("listening")) }
#Preview("Hearing") { VoiceScreen(engine: VoiceFixtures.engine("hearing")) }
#Preview("Thinking") { VoiceScreen(engine: VoiceFixtures.engine("thinking")) }
#Preview("Working") { VoiceScreen(engine: VoiceFixtures.engine("working")) }
#Preview("Speaking") { VoiceScreen(engine: VoiceFixtures.engine("speaking")) }
#Preview("Asking") { VoiceScreen(engine: VoiceFixtures.engine("asking")) }
#Preview("Select") { VoiceScreen(engine: VoiceFixtures.engine("select")) }
#Preview("Undo window") { VoiceScreen(engine: VoiceFixtures.engine("grace")) }
#Preview("Paused (push to talk)") { VoiceScreen(engine: VoiceFixtures.engine("paused")) }
#Preview("Muted") { VoiceScreen(engine: VoiceFixtures.engine("muted")) }
#Preview("Holding") { VoiceScreen(engine: VoiceFixtures.engine("ptt")) }
#Preview("Connecting") { VoiceScreen(engine: VoiceFixtures.engine("connecting")) }
#Preview("Offline") { VoiceScreen(engine: VoiceFixtures.engine("offline")) }
#Preview("Dark, AX5") {
    VoiceScreen(engine: VoiceFixtures.engine("asking")).preferredColorScheme(.dark).dynamicTypeSize(.accessibility5)
}
#Preview("Settings") { VoiceSettingsSheet(engine: VoiceFixtures.engine("listening")) }
#Preview("Sessions") { VoiceSessionSheet(engine: VoiceFixtures.engine("listening")) }
#endif
