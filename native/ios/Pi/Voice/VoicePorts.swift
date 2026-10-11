import Foundation

// The seams between VoiceEngine (pure behaviour, ported from web/voice.js) and the platform:
// the machines (sealed RPC + events), the realtime call (WebRTC), basic-voice audio and earcons.
// Tests drive the engine through fakes of these (PiTests/Voice).

/// One computer as voice mode sees it.
struct FleetMachine: Sendable, Equatable {
    var id: String
    var name: String
}

enum FleetUpdate: Sendable, Equatable {
    case event(machine: String, HubEvent)
    case state(machine: String, HubClient.ConnectionState)
}

/// Every paired machine: RPC per machine and one merged update stream.
@MainActor
protocol VoiceFleet: AnyObject {
    var machines: [FleetMachine] { get }
    /// A hub-level RPC (`hub`, `focus`, …) on one machine.
    func rpc(machine: String, _ m: String, _ p: JSON) async throws -> JSON
    /// An agent RPC (`agent { agent, m, p }`) on the machine that hosts `agent`.
    func agentCall(machine: String, agent: String, _ m: String, _ p: JSON) async throws -> JSON
    /// Asks that machine's stream for the detailed events of `agent`.
    func focus(machine: String, agent: String) async
    /// Hub events and connection states of every machine. One consumer.
    func updates() -> AsyncStream<FleetUpdate>
    /// Network path changed (NWPathMonitor): reopen event streams.
    func reconnect()
    /// The app's machine list changed (added, removed, re-paired); returns the ids that are new or re-paired.
    @discardableResult func setMachines(_ list: [Machine]) -> Set<String>
}

/// The OpenAI realtime call (WebRTC + `oai-events` data channel). `RealtimeClient` in the app.
@MainActor
protocol RealtimeTransport: AnyObject {
    /// Builds the offer, hands it to `exchange` (the `voiceSession` RPC) and applies the answer;
    /// returns once the data channel is open (throws "realtime voice did not connect" after 15 s).
    func connect(exchange: @escaping @MainActor (String) async throws -> String) async throws
    /// Sends one client event on the data channel (dropped unless open).
    func send(_ event: JSON)
    /// Server events from the data channel, in order.
    var onEvent: (@MainActor (JSON) -> Void)? { get set }
    /// The peer connection failed or closed after connecting.
    var onLost: (@MainActor () -> Void)? { get set }
    /// The microphone track's `isEnabled`.
    var micEnabled: Bool { get set }
    /// pi's voice volume, 1 normal, 0.2 ducked.
    var remoteVolume: Double { get set }
    /// Smoothed levels (0–1): the mic and pi's voice.
    var micLevel: Double { get }
    var piLevel: Double { get }
    /// The mic's raw linear level for the client VAD (web: analyser RMS), not display-scaled.
    var micRaw: Double { get }
    func close()
}

/// Basic voice's audio (`startCascade`, `speak`, `speakLocal`, `silence`): the mic as frames,
/// pi's audio from the computer, and the phone's own synthesis. `BasicVoice` in the app.
@MainActor
protocol BasicAudio: AnyObject {
    /// Starts the mic; `onFrame(samples, sampleRate)` for each buffer (about 2048 samples).
    func start(onFrame: @escaping @MainActor ([Float], Double) -> Void) throws
    func stop()
    /// Plays encoded audio from the computer (`speak` RPC); `done` when it ends or fails.
    func play(_ audio: Data, mime: String, done: @escaping @MainActor () -> Void) throws
    /// Speaks with the phone's synthesizer: `parts` in order, `done` after the last.
    func speakLocal(_ parts: [String], persona: VoicePersona?, rate: Double, done: @escaping @MainActor () -> Void)
    /// Stops whatever is playing or speaking (no `done`).
    func silence()
    /// Output volume, 1 normal, 0.2 ducked; local synthesis pauses when ducked.
    func setDucked(_ ducked: Bool)
    var isSpeaking: Bool { get }
    /// The output level (0–1) while the computer's audio plays, nil for the phone's synthesis.
    var outLevel: Double? { get }
}

/// The short sounds from `PiVoiceCore.EARCONS`.
@MainActor
protocol EarconPlaying: AnyObject {
    func play(_ name: String)
    /// Stops the earcon engine (before the audio session is deactivated).
    func stop()
}

/// The audio session: D5 configuration, interruptions, routes, input mute (D8).
@MainActor
protocol VoiceAudioSession: AnyObject {
    func activate() throws
    func deactivate()
    var route: String { get }
    /// Interruption began (`true`) / ended with `.shouldResume` (`false`); ended without it → `nil`.
    var onInterruption: (@MainActor (_ began: Bool?) -> Void)? { get set }
    var onRouteChange: (@MainActor (String) -> Void)? { get set }
    /// System input mute (AirPods stem, Control Center) changed.
    var onInputMute: (@MainActor (Bool) -> Void)? { get set }
    func setInputMuted(_ muted: Bool)
    /// The system input mute now (it persists across launches).
    var isInputMuted: Bool { get }
    /// Headset or lock-screen play/pause: acts like tapping the circle.
    var onRemoteToggle: (@MainActor () -> Void)? { get set }
    /// Network path changed after being satisfied.
    var onNetworkChange: (@MainActor () -> Void)? { get set }
}

/// A cancellable timer from `VoiceScheduler`.
@MainActor
final class VoiceTimer {
    private var cancelHandler: (() -> Void)?
    init(cancel: @escaping () -> Void) { cancelHandler = cancel }
    func cancel() { cancelHandler?(); cancelHandler = nil }
}

/// setTimeout / setInterval; tests use a manual clock.
@MainActor
protocol VoiceScheduler: AnyObject {
    func after(_ seconds: Double, _ f: @escaping @MainActor () -> Void) -> VoiceTimer
    func every(_ seconds: Double, _ f: @escaping @MainActor () -> Void) -> VoiceTimer
}

/// The real one: main-actor Tasks.
@MainActor
final class TaskScheduler: VoiceScheduler {
    func after(_ seconds: Double, _ f: @escaping @MainActor () -> Void) -> VoiceTimer {
        let t = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { f() }
        }
        return VoiceTimer { t.cancel() }
    }
    func every(_ seconds: Double, _ f: @escaping @MainActor () -> Void) -> VoiceTimer {
        let t = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(seconds))
                if !Task.isCancelled { f() }
            }
        }
        return VoiceTimer { t.cancel() }
    }
}

/// Everything the engine needs from outside; the app passes live parts, tests pass fakes.
@MainActor
struct VoiceDeps {
    var fleet: VoiceFleet
    var core: VoiceCore
    var makeRealtime: @MainActor () -> RealtimeTransport
    var makeBasic: @MainActor () -> BasicAudio
    var earcons: EarconPlaying
    var audioSession: VoiceAudioSession?
    var prefs: VoicePrefs
    var scheduler: VoiceScheduler = TaskScheduler()
    var now: @MainActor () -> Date = { Date() }
    /// Monotonic ms for VAD frames.
    var ms: @MainActor () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
}
