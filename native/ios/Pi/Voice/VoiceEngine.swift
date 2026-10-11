import Foundation
import Observation

/// What the voice screen shows, in `web/voice.js` terms (`LABEL`).
enum VoiceState: String, Sendable, CaseIterable {
    case connecting, listening, hearing, thinking, working, speaking, asking, paused, offline
}

/// `eyes-busy` (default) or `glance` (`pi-mobile-voice-attention`).
enum VoiceAttention: String, Sendable { case eyesBusy = "eyes-busy", glance }
/// Open mic (`open`) or push to talk (`tap`) (`pi-mobile-voice-turns`).
enum VoiceTurns: String, Sendable { case open, tap }
/// Which engine carries the call: OpenAI realtime over WebRTC, or basic voice (transcribe + speak).
enum VoiceEngineKind: String, Sendable { case realtime, basic }

/// A voice the computer offers (`voices` RPC).
struct VoicePersona: Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var blurb: String
    var rate: Double
    var phonePrefer: [String]
    var phonePitch: Double
}

/// The question card: pi's open dialog, answered by voice or a tap (`renderAsk`).
struct VoiceQuestion: Sendable, Equatable, Identifiable {
    struct Option: Sendable, Equatable, Hashable {
        var label: String
        /// The JSON value `answer` sends: `true`/`false` for confirm, the option text for select, `nil` = cancel.
        var value: JSON?
        var destructive: Bool
        var primary: Bool = false
        var ghost: Bool = false
    }
    /// The undo window (`startGrace`): going ahead at `until` unless cancelled.
    struct Grace: Sendable, Equatable {
        var until: Date
        var total: TimeInterval
        func secondsLeft(_ now: Date = Date()) -> Int { max(0, Int((until.timeIntervalSince(now)).rounded(.up))) }
        func fraction(_ now: Date = Date()) -> Double { max(0, min(1, until.timeIntervalSince(now) / total)) }
        /// "Going ahead in 3 s, as you asked. Say “stop” or tap Cancel."
        func text(_ now: Date = Date()) -> String { "Going ahead in \(secondsLeft(now)) s, as you asked. Say “stop” or tap Cancel." }
    }
    var id: String
    var kind: String          // confirm | select | input
    var title: String
    var message: String?
    var destructive: Bool
    /// Empty for free-text questions: the card says "Say your answer."
    var options: [Option]
    var grace: Grace?
}

/// Mic and pi levels for the orb, the Live Activity and the dictation strip (0–1, smoothed).
struct VoiceLevels: Sendable, Equatable {
    var mine: Double = 0
    var pi: Double = 0
}

struct VoiceSettings: Sendable, Equatable {
    var attention: VoiceAttention = .eyesBusy
    var turns: VoiceTurns = .open
    var persona: String = "marin"
    var personas: [VoicePersona] = []
    /// Why basic voice is used (kept for the settings sheet), nil while realtime works.
    var basicReason: String?
}

/// A setting the user can change by voice or in the sheet (`applySetting`).
enum VoiceSetting: String, Sendable { case pushToTalk, openMic, eyesFree, glance }

/// A session the switcher lists (every reachable session on every machine).
struct VoiceSessionItem: Sendable, Equatable, Identifiable {
    var id: String { "\(machine)/\(agent)" }
    var agent: String
    var machine: String
    var name: String
    /// Machine name, set only when there are several machines.
    var machineName: String?
    var status: String
    var waiting: Int
}

/// One caption line: what you said (`heard`) or what pi says (`said`), `live` while still arriving.
struct VoiceCaption: Sendable, Equatable {
    var text: String = ""
    var live: Bool = false
}

/// Native voice mode: port of `web/voice.js` `class VoiceMode` (plans/native-apps.md §7).
/// The UI binds to the observable properties and calls the actions; nothing else is public.
@MainActor @Observable
final class VoiceEngine {
    static let labels: [VoiceState: String] = [
        .connecting: "Connecting…", .listening: "Listening", .hearing: "Listening…", .thinking: "Got it",
        .working: "pi is on it", .speaking: "", .asking: "pi needs you", .paused: "Mic off", .offline: "Reconnecting…",
    ]

    // MARK: observable surface
    /// True from `start` until `stop`.
    private(set) var isOpen = false
    private(set) var state: VoiceState = .connecting
    /// nil while connecting or after the microphone failed (tap retries).
    private(set) var engineKind: VoiceEngineKind?
    private(set) var heard = VoiceCaption()
    private(set) var said = VoiceCaption()
    /// A transient note under the captions (errors, "Using basic voice…").
    private(set) var note = ""
    private(set) var question: VoiceQuestion?
    private(set) var muted = false
    /// Push to talk: holding the floor / with a finger on the circle.
    private(set) var talking = false
    private(set) var holding = false
    var levels = VoiceLevels()
    private(set) var agent = ""
    private(set) var machineId = ""
    private(set) var sessionName = ""
    /// The machine's name, shown only when there are several (else nil).
    private(set) var machineName: String?
    /// The session's status line (same as the app header) and its dot class.
    private(set) var sessionLine = ""
    private(set) var sessionStatus = ""
    /// Output route, e.g. "AirPods Pro" or "Speaker".
    private(set) var route = ""
    private(set) var settings = VoiceSettings()
    /// Sessions for the switcher.
    private(set) var sessions: [VoiceSessionItem] = []
    /// Seconds pi has worked (for the hint); updated by the tick.
    private(set) var workingSince: Date?
    /// Times voice mode was opened (hints fade with use).
    private(set) var uses = 0
    /// Bumped by the 1 s tick so time-dependent copy (`hint`, grace) re-renders.
    private(set) var now = Date()

    /// The big state word (`LABEL`, with the paused variants of `render`).
    var label: String {
        if state == .paused { return muted ? "Mic off" : settings.turns == .tap ? "Push to talk" : "Paused" }
        return Self.labels[state] ?? state.rawValue
    }

    /// One line under the state: what you can do now (`hint()`).
    var hint: String {
        switch state {
        case .listening:
            if uses > 6 { return "" }
            let tries = ["Try “what's it doing?”", "Try “stop” — it works any time", "Try “tell me more”", "Try “switch to another session”", "Try “say that again”"]
            return uses <= 1 ? "Just talk — say “stop” any time" : tries[Int(now.timeIntervalSince1970 / 8) % tries.count]
        case .working:
            let s = workingSince.map { max(0, Int(now.timeIntervalSince($0))) } ?? 0
            return "\(s >= 60 ? "\(s / 60) min " : "")\(s % 60)s · ask “what's it doing?” any time"
        case .speaking: return "Talk or tap to interrupt"
        case .asking: return "Answer out loud, or tap below"
        case .paused: return muted ? "Tap to unmute" : settings.turns == .tap ? "Hold while you talk, or tap to start and stop" : "Tap to resume"
        case .hearing: return settings.turns != .tap ? "" : holding ? "Let go when you're done" : "Tap when you're done"
        default: return ""
        }
    }

    /// The circle's accessibility action (`stageAction`).
    var stageAction: String {
        if engineKind == nil { return "Retry the microphone" }
        if state == .speaking { return "Interrupt" }
        if muted { return "Unmute" }
        if settings.turns == .tap { return talking ? "Done talking" : "Talk" }
        return "Listening"
    }

    // MARK: actions (stubs; implemented in the engine step)
    func start(agent: String, machine: String) async { isOpen = true; self.agent = agent; machineId = machine }
    func stop() { isOpen = false }
    /// Push to talk press; returns true when the press started a turn (then its tap is swallowed).
    @discardableResult func pressStart() -> Bool { false }
    func pressEnd(held: Bool) {}
    func tap() {}
    func toggleMute() { muted.toggle() }
    func answer(_ option: VoiceQuestion.Option) async {}
    func cancelGrace() {}
    func doItNow() async {}
    func setPersona(_ id: String) async { settings.persona = id }
    func applySetting(_ setting: VoiceSetting) {}
    func switchSession(agent: String, machine: String) {}

    init() {}
}
