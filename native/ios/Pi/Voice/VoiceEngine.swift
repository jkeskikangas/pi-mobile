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

    // MARK: public actions

    /// Called once voice mode has closed (the bridge then calls `window.PiNative.voiceClosed()`).
    @ObservationIgnored var onClose: (@MainActor () -> Void)?

    /// Opens voice mode on a session (`open`). If already open, follows `agent` instead.
    func start(agent: String, machine: String) async {
        if isOpen && !closed {
            if key(machine, agent) != cur { follow(machine: machine, agent: agent) }
            return
        }
        guard let deps else { isOpen = true; self.agent = agent; machineId = machine; return }
        closed = false
        gen += 1
        isOpen = true
        state = .connecting
        engineKind = nil
        heard = VoiceCaption()
        said = VoiceCaption()
        note = ""
        muted = false
        talking = false
        holding = false
        interrupted = false
        workingSince = nil
        resetConversation()
        self.agent = agent
        machineId = machine
        speechMachine = nil
        settings.attention = deps.prefs.get(Self.modeKey) == "glance" ? .glance : .eyesBusy
        settings.turns = deps.prefs.get(Self.turnKey) == "tap" ? .tap : .open
        if let p = deps.prefs.get(Self.personaKey) { settings.persona = p }
        uses = Int(deps.prefs.get(Self.usesKey) ?? "") ?? 0
        wireAudioSession()
        listen()
        let g = gen
        await loadWorld()
        if closed || g != gen { return }
        // A hub too old for native voice: say so on screen, don't half-work.
        if incompatible.contains(machineId) {
            let name = machineNameOf(machineId).isEmpty ? "that computer" : machineNameOf(machineId)
            setNote("Voice mode needs a newer pi-mobile on \(name). Update it there, then try again.")
            earcon("failed")
            return setState(.paused)
        }
        loadPersonas()
        await open()
    }

    /// Ends voice mode (`close`).
    func stop() {
        guard isOpen, !closed else { return }
        closed = true
        gen += 1
        // Mute ends with the session (End button, Live Activity, intent, error): the app-wide input mute
        // would otherwise silence every later dictation (issue #3).
        if muted || deps?.audioSession?.isInputMuted == true { deps?.audioSession?.setInputMuted(false) }
        muted = false
        dropGrace() // pi's question stays open in the app and the terminal
        deps?.earcons.play("off")
        if let fleet = deps?.fleet, !agent.isEmpty {
            let (m, a, mode) = (machineId, agent, settings.attention.rawValue)
            Task { _ = try? await fleet.agentCall(machine: m, agent: a, "voiceState", ["on": false, "mode": .string(mode)]) }
        }
        for t in timers { t.cancel() }
        timers = []
        stopRealtime()
        stopCascade()
        silence()
        clientVad?.cancel()
        clientVad = nil
        continueTimer?.cancel()
        continueTimer = nil
        redial?.cancel()
        redial = nil
        updatesTask?.cancel()
        updatesTask = nil
        levels = VoiceLevels()
        isOpen = false
        // Let the "off" earcon play out, then release the audio session (unless voice mode reopened).
        let g = gen
        if let deps {
            _ = deps.scheduler.after(0.35) { [weak self] in
                guard let self, self.gen == g else { return }
                deps.earcons.stop()
                // Dictation may have taken the session in the meantime: then it isn't ours to release.
                if AudioOwner.shared.owns(self.audioToken) { deps.audioSession?.deactivate() }
                self.audioToken = nil
            }
        }
        onClose?()
    }

    /// Everything one voice mode learned; a new voice mode starts fresh (the web makes a new VoiceMode).
    func resetConversation() {
        grace?.timer.cancel()
        grace = nil
        recentHeard = []
        lastHeardEcho = false
        lastSpoken = ""
        more = []
        optionPage = 0
        significant = [:]
        saidLive = ""
        heardLive = ""
        active = false
        wantResponse = false
        userSpeaking = false
        calls = []
        serverTurns = nil
        cturn = nil
        overlap = false
        ducked = false
        shortTurn = false
        capture = nil
        pre = []
        manual = false
        pendingText = ""
        serverTts = nil
    }

    /// Push to talk: pressing the circle starts your turn at once, over pi if it is talking.
    @discardableResult func pressStart() -> Bool {
        if settings.turns != .tap || engineKind == nil || muted || talking { return false }
        holding = true
        toggleTalk()
        return true
    }

    /// Letting go after a hold ends the turn; after a quick tap you stay talking until the next tap.
    func pressEnd(held: Bool) {
        holding = false
        if held && talking {
            toggleTalk()
        } else { render() }
    }

    /// The stage: interrupt pi speaking; otherwise unmute, or (tap to talk) take and give back the floor.
    func tap() {
        if interrupted { return resumeAfterInterruption() }
        if engineKind == nil {
            if state != .connecting { Task { await restart() } }
            return
        }
        if state == .speaking { return interrupt() }
        if muted { return setMuted(false) }
        if settings.turns == .tap { return toggleTalk() }
        if engineKind == .basic && state == .paused { return setState(.listening) }
        earcon("listen")
    }

    func toggleMute() { setMuted(!muted) }

    /// A tap on the question card (`renderAsk` → answer).
    func answer(_ option: VoiceQuestion.Option) async {
        guard let id = question?.id else { return }
        await answer(option, questionId: id)
    }

    /// Answers only if `questionId` is still pi's open question (a tap on a card that changed is rejected).
    @discardableResult
    func answer(_ option: VoiceQuestion.Option, questionId: String) async -> Bool {
        guard !closed, let p = openPrompt, p["id"]?.string == questionId, grace == nil else { return false }
        let g = gen
        do {
            var params: [String: JSON] = ["id": p["id"] ?? .null]
            if let v = option.value { params["value"] = v }
            try await sessionCall("answer", .object(params))
            guard g == gen, !closed else { return true }
            if engineKind == .realtime { inject("[PI] The developer answered on screen: \(option.label). Do not ask again.", respond: false) }
            silence()
            if engineKind == .realtime && active { rt(["type": "response.cancel"]) }
            earcon("heard")
            return true
        } catch {
            if g == gen, !closed { setNote(error.localizedDescription) }
            return false
        }
    }

    /// Cancels the undo window: pi's question is answered no.
    func cancelGrace() { cancelGrace(quiet: false) }

    /// "Do it now" during the undo window.
    func doItNow() async { await finishGrace(true) }

    /// A new voice. A realtime call keeps its voice once it has spoken, so it is redialled; basic voice just uses it.
    func setPersona(_ id: String) async {
        settings.persona = id
        deps?.prefs.set(Self.personaKey, id)
        render()
        let p = currentPersona
        if engineKind == .basic { return speak(Self.sampleLine(p)) }
        if engineKind != .realtime { return }
        let g = gen
        stopRealtime()
        setState(.connecting)
        do {
            try await startRealtime()
            guard g == gen, !closed else { return }
            inject("[PI] The developer just picked a new voice for you. Say only one short sentence in it: \"This is \(p?.name ?? "me").\"", respond: true)
        } catch {
            // Ended (or reopened) while redialling: no fallback, no mic.
            guard g == gen, !closed, engineKind == nil else { return }
            stopRealtime()
            startCascade()
            render()
            basic(error.localizedDescription)
            speak(Self.sampleLine(p))
        }
    }

    /// "Push to talk", "open mic", "eyes free", "I can glance": settings by voice or the sheet.
    func applySetting(_ setting: VoiceSetting) {
        switch setting {
        case .pushToTalk: setTurns(.tap)
        case .openMic: setTurns(.open)
        case .eyesFree: setAttention(.eyesBusy)
        case .glance: setAttention(.glance)
        }
        earcon("heard")
    }

    /// Follow another session (switcher). Keeps the call.
    func switchSession(agent: String, machine: String) {
        guard key(machine, agent) != cur else { return }
        follow(machine: machine, agent: agent)
    }

    /// Tests and previews: show a state with sample captions (`PiVoice.preview`).
    #if DEBUG
    /// Only the given fields change (double optionals: `.some(nil)` clears). Sets `isOpen`.
    func preview(state s: VoiceState? = nil, engineKind ek: VoiceEngineKind?? = nil, heard h: VoiceCaption? = nil, said sd: VoiceCaption? = nil,
                 note n: String? = nil, question q: VoiceQuestion?? = nil, muted m: Bool? = nil, talking t: Bool? = nil, holding ho: Bool? = nil,
                 sessionName sn: String? = nil, machineName mn: String?? = nil, sessionLine sl: String? = nil, sessionStatus ss: String? = nil,
                 route ro: String? = nil, settings st: VoiceSettings? = nil, sessions se: [VoiceSessionItem]? = nil, workingSince ws: Date?? = nil,
                 uses u: Int? = nil, now nw: Date? = nil) {
        if let ek { engineKind = ek }
        if let h { heard = h }
        if let sd { said = sd }
        if let n { note = n }
        if let q { question = q }
        if let m { muted = m }
        if let t { talking = t }
        if let ho { holding = ho }
        if let sn { sessionName = sn }
        if let mn { machineName = mn }
        if let sl { sessionLine = sl }
        if let ss { sessionStatus = ss }
        if let ro { route = ro }
        if let st { settings = st }
        if let se { sessions = se }
        if let ws { workingSince = ws }
        if let u { uses = u }
        if let nw { now = nw }
        if let s { state = s }
        isOpen = true
    }

    static func fixture(_ configure: (VoiceEngine) -> Void) -> VoiceEngine {
        let e = VoiceEngine()
        e.isOpen = true
        configure(e)
        return e
    }
    #endif

    /// Gives the app's single engine its live parts before `start` (ignored while open).
    func attach(_ d: VoiceDeps) {
        guard !isOpen || closed else { return }
        deps = d
    }
    init() {}

    init(deps: VoiceDeps) { self.deps = deps }

    // MARK: constants (web/voice.js)
    static let modeKey = "pi-mobile-voice-attention"
    static let turnKey = "pi-mobile-voice-turns"
    static let personaKey = "pi-mobile-voice-persona"
    static let usesKey = "pi-mobile-voice-uses"
    static let introKey = "pi-mobile-voice-intro"
    static let graceMs = 4000.0
    /// Voiced speech over pi that takes the turn (Hume's default); pi ducks at once meanwhile.
    static let bargeMs = 800.0
    /// Turns shorter than this (server-measured) wait for their words.
    static let shortTurnMs = 1300.0
    static let holdMs = 350.0
    static func sampleLine(_ p: VoicePersona?) -> String { "This is \(p?.name ?? "pi"). The tests pass, and the change is ready for you to review." }

    // MARK: internal state (not observed)
    @ObservationIgnored var deps: VoiceDeps?
    @ObservationIgnored var core: VoiceCore? { deps?.core }
    @ObservationIgnored var rtc: RealtimeTransport?
    @ObservationIgnored var basicIO: BasicAudio?
    @ObservationIgnored var closed = false
    /// Bumped by every start and stop: async work checks it after each await.
    @ObservationIgnored var gen = 0
    @ObservationIgnored var redial: Task<Void, Never>?
    @ObservationIgnored var graceSeq = 0
    @ObservationIgnored var timers: [VoiceTimer] = []
    @ObservationIgnored var updatesTask: Task<Void, Never>?
    // The world: every machine's sessions and open questions, keyed "machine/agent".
    @ObservationIgnored var infos: [String: JSON] = [:]
    @ObservationIgnored var prompts: [String: [JSON]] = [:]
    @ObservationIgnored var statusOf: [String: String] = [:]
    @ObservationIgnored var machineStates: [String: HubClient.ConnectionState] = [:]
    @ObservationIgnored var wasOffline: Set<String> = []
    /// Machines whose hub lacks what native voice needs.
    @ObservationIgnored var incompatible: Set<String> = []
    /// Audio-session ownership taken when voice mode activated it.
    @ObservationIgnored var audioToken: Int?
    /// Where speech runs (`voiceSession`, `speak`, `voices`, `transcribe`, `distill`); kept across switches.
    @ObservationIgnored var speechMachine: String?
    // Conversation
    @ObservationIgnored var lastSpoken = ""
    @ObservationIgnored var more: [String] = []
    @ObservationIgnored var optionPage = 0
    @ObservationIgnored var lastTick = Date.distantPast
    @ObservationIgnored var significant: [String: String] = [:]
    @ObservationIgnored var recentHeard: [(text: String, at: Date, echo: Bool)] = []
    @ObservationIgnored var lastHeardEcho = false
    typealias Grace = (prompt: JSON, until: Date, timer: VoiceTimer, id: Int)
    @ObservationIgnored var grace: Grace?
    @ObservationIgnored var interrupted = false
    // Realtime
    @ObservationIgnored var saidLive = ""
    @ObservationIgnored var heardLive = ""
    @ObservationIgnored var active = false
    @ObservationIgnored var wantResponse = false
    @ObservationIgnored var userSpeaking = false
    @ObservationIgnored var calls: Set<String> = []
    @ObservationIgnored var serverTurns: JSON?
    @ObservationIgnored var clientVad: VoiceTimer?
    @ObservationIgnored var cvad: VoiceCore.Vad?
    @ObservationIgnored var cturn: (voiced: Double, interrupted: Bool)?
    @ObservationIgnored var overlap = false
    @ObservationIgnored var ducked = false
    @ObservationIgnored var shortTurn = false
    @ObservationIgnored var turnStart = 0.0
    // Basic voice
    @ObservationIgnored var vad: VoiceCore.Vad?
    @ObservationIgnored var capture: [[Float]]?
    @ObservationIgnored var pre: [[Float]] = []
    @ObservationIgnored var rate = 48000.0
    @ObservationIgnored var manual = false
    @ObservationIgnored var voicedMs = 0.0
    @ObservationIgnored var pendingText = ""
    @ObservationIgnored var continueTimer: VoiceTimer?
    @ObservationIgnored var serverTts: Bool?
    @ObservationIgnored var speakTurn = 0
    @ObservationIgnored var basicLevel = 0.0

    // MARK: world
    func key(_ machine: String, _ agent: String) -> String { "\(machine)/\(agent)" }
    var cur: String { key(machineId, agent) }
    var several: Bool { (deps?.fleet.machines.count ?? 0) > 1 }
    func split(_ k: String) -> (machine: String, agent: String) {
        let i = k.firstIndex(of: "/") ?? k.endIndex
        return (String(k[..<i]), i < k.endIndex ? String(k[k.index(after: i)...]) : "")
    }
    func machineNameOf(_ id: String) -> String { deps?.fleet.machines.first { $0.id == id }?.name ?? "" }
    func agentName(_ k: String) -> String { infos[k]?["name"]?.string ?? "pi" }
    /// "api on hetzner-box" when there are several machines.
    func sessionLabel(_ k: String) -> String {
        let name = agentName(k), m = machineNameOf(split(k).machine)
        return several && !m.isEmpty ? "\(name) on \(m)" : name
    }
    func reachable(_ k: String) -> Bool { machineStates[split(k).machine] != .offline }
    var openPrompt: JSON? { prompts[cur]?.first }
    var answering: Bool { !(prompts[cur]?.isEmpty ?? true) }

    func loadWorld() async {
        guard let fleet = deps?.fleet else { return }
        // All machines at once; a machine that doesn't answer counts as offline.
        let pending = fleet.machines.map { m in (m.id, Task { try? await fleet.rpc(machine: m.id, "hub", [:]) }) }
        for (id, task) in pending { took(id, await task.value) }
        await loadPrompts(cur)
        await fleet.focus(machine: machineId, agent: agent)
    }

    /// What native voice needs from a hub (`hub` rpc `protocol` and `features`, plan Step 1).
    static let protocolVersion = 1
    static let neededFeatures = ["voice", "voiceSession", "speak", "voices"]
    static func compatible(_ hub: JSON) -> Bool {
        let features = Set(hub["features"]?.array?.compactMap(\.string) ?? [])
        return hub["protocol"]?.int == protocolVersion && neededFeatures.allSatisfy(features.contains)
    }

    /// One machine's `hub` reply: its sessions, and whether it can do voice at all.
    func took(_ id: String, _ hub: JSON?) {
        guard let hub, let agents = hub["agents"]?.array else { machineStates[id] = .offline; return }
        if Self.compatible(hub) { incompatible.remove(id) } else { incompatible.insert(id) }
        for a in agents {
            guard let ag = a["agent"]?.string else { continue }
            infos[key(id, ag)] = a
            statusOf[key(id, ag)] = a["status"]?.string
        }
    }

    /// The app's machine list changed while voice mode runs: new and re-paired machines are loaded,
    /// removed ones vanish with their sessions; losing the followed session's machine ends voice mode.
    func machinesChanged(_ list: [Machine]) {
        guard isOpen, !closed, let fleet = deps?.fleet else { return }
        let before = Set(fleet.machines.map(\.id))
        let changed = fleet.setMachines(list)
        let now = Set(list.map(\.id))
        for id in before.subtracting(now) {
            for k in Array(infos.keys) where split(k).machine == id {
                infos[k] = nil
                prompts[k] = nil
                statusOf[k] = nil
            }
            machineStates[id] = nil
            wasOffline.remove(id)
            incompatible.remove(id)
            if speechMachine == id { speechMachine = nil }
        }
        render()
        if !now.contains(machineId) {
            setNote("That computer was removed from this iPhone.")
            return stop()
        }
        let g = gen
        for id in changed {
            Task { [weak self] in
                let hub = try? await fleet.rpc(machine: id, "hub", [:])
                guard let self, self.gen == g, !self.closed else { return }
                self.took(id, hub)
                self.render()
            }
        }
    }

    func loadPrompts(_ k: String) async {
        let (m, a) = split(k)
        guard let fleet = deps?.fleet, let snap = try? await fleet.agentCall(machine: m, agent: a, "snapshot", ["limit": 0]) else { return }
        if let list = snap["prompts"]?.array { prompts[k] = list }
        if let info = snap["info"], info.object != nil { infos[k] = info; statusOf[k] = info["status"]?.string }
        render()
    }

    /// Hub events and machine states for the life of voice mode.
    func listen() {
        guard updatesTask == nil, let fleet = deps?.fleet else { return }
        let stream = fleet.updates()
        updatesTask = Task { @MainActor [weak self] in
            for await u in stream {
                guard let self, !self.closed else { return }
                switch u {
                case .event(let m, let ev): self.apply(machine: m, ev)
                case .state(let m, let s): self.machineState(m, s)
                }
            }
        }
    }

    /// The app's state first (`handleEvent`), then voice mode's reaction (`onEvent`).
    func apply(machine m: String, _ ev: HubEvent) {
        guard let a = ev.agent else { return }
        let k = key(m, a)
        var prevStatus: String?
        switch ev.type {
        case "info":
            prevStatus = statusOf[k]
            if let info = ev.raw["info"] { infos[k] = info; statusOf[k] = info["status"]?.string }
        case "gone":
            infos[k] = nil
            prompts[k] = nil
        case "prompt":
            if let p = ev.raw["prompt"] { prompts[k, default: []].append(p) }
        case "prompt_end":
            prompts[k]?.removeAll { $0["id"] == ev.raw["id"] }
        default: break
        }
        onEvent(k, ev, prevStatus: prevStatus)
        render()
    }

    /// A computer went away or came back; voice mode says so once if it's the one it follows.
    func machineState(_ m: String, _ s: HubClient.ConnectionState) {
        machineStates[m] = s
        let name = machineNameOf(m).isEmpty ? "The computer" : machineNameOf(m)
        if s == .offline, !wasOffline.contains(m) {
            wasOffline.insert(m)
            if speechMachine == m { speechMachine = nil } // the next speech call picks another
            if m == machineId { onMachine(name, back: false) }
        } else if s == .online, wasOffline.remove(m) != nil {
            if m == machineId { onMachine(name, back: true) }
        }
        render()
    }

    func onMachine(_ name: String, back: Bool) {
        if !back { earcon("failed") }
        tell(back ? "\(name) is back." : "\(name) went offline.", "[PI] The computer \"\(name)\" \(back ? "is reachable again" : "went offline; its sessions can't be reached until it's back. Other sessions still work"). Say only: \"\(name) \(back ? "is back" : "went offline").\"")
    }

    // MARK: calls
    @discardableResult
    func sessionCall(_ m: String, _ p: JSON = [:]) async throws -> JSON {
        guard let fleet = deps?.fleet, !closed else { throw HubError.network("Voice mode is not connected.") }
        return try await fleet.agentCall(machine: machineId, agent: agent, m, p)
    }

    /// Speech runs where the credentials are: the speech machine (the session's own first), then any
    /// other online machine through one of its sessions. Only "can't do speech" moves on.
    func speechCall(_ m: String, _ p: JSON) async throws -> JSON {
        guard let fleet = deps?.fleet, !closed else { throw HubError.network("Voice mode is not connected.") }
        let home = speechMachine ?? machineId
        var tries: [(String, String)] = []
        if home == machineId { tries.append((machineId, agent)) } else if let a = agentOn(home) { tries.append((home, a)) }
        if home != machineId, reachable(cur) { tries.append((machineId, agent)) }
        for mm in fleet.machines where mm.id != home && mm.id != machineId && machineStates[mm.id] != .offline && !incompatible.contains(mm.id) {
            if let a = agentOn(mm.id) { tries.append((mm.id, a)) }
        }
        var last: Error = HubError.remote("no computer can do speech")
        for (mid, a) in tries {
            do {
                let r = try await fleet.agentCall(machine: mid, agent: a, m, p)
                speechMachine = mid
                return r
            } catch {
                last = error
                if closed { throw error }
                // The speech machine can't be reached: forget it and re-pick from the next machine (once).
                if case HubError.network = error, mid == home, tries.count > 1 {
                    if speechMachine == mid { speechMachine = nil }
                    continue
                }
                if error.localizedDescription.range(of: #"unavailable|not set up|no speech|no recogni|api key|sign.?in"#, options: [.regularExpression, .caseInsensitive]) == nil { throw error }
            }
        }
        throw last
    }

    func agentOn(_ m: String) -> String? {
        infos.keys.sorted().first { split($0).machine == m }.map { split($0).agent }
    }

    func heartbeat(_ on: Bool) {
        guard deps != nil, !agent.isEmpty else { return }
        let mode = settings.attention.rawValue
        Task { try? await sessionCall("voiceState", ["on": .bool(on), "mode": .string(mode)]) }
    }

    func loadPersonas() {
        Task { [weak self] in
            guard let self, let r = try? await self.speechCall("voices", [:]), let list = r["personas"]?.array else { return }
            self.settings.personas = list.compactMap { p in
                guard let id = p["id"]?.string else { return nil }
                return VoicePersona(id: id, name: p["name"]?.string ?? id, blurb: p["blurb"]?.string ?? "", rate: p["rate"]?.number ?? 1,
                                    phonePrefer: (p["phone"]?["prefer"]?.string ?? "").split(separator: "|").map(String.init), phonePitch: p["phone"]?["pitch"]?.number ?? 1)
            }
        }
    }

    var currentPersona: VoicePersona? { settings.personas.first { $0.id == settings.persona } ?? settings.personas.first }

    // MARK: lifecycle
    func open() async {
        guard let deps else { return }
        render()
        if let s = deps.audioSession {
            do { try s.activate() } catch {
                setNote("\(error.localizedDescription) Tap the circle to try again.")
                return setState(.paused)
            }
            route = s.route
            audioToken = AudioOwner.shared.claim()
            // Mute is scoped to a voice session (issue #3): a new session starts unmuted, even if a mute
            // (AirPods, Control Center, an earlier session) was left on app-wide.
            if s.isInputMuted { s.setInputMuted(false) }
            muted = false
        }
        for (k, v) in infos { statusOf[k] = v["status"]?.string }
        heartbeat(true)
        timers.append(deps.scheduler.every(60) { [weak self] in self?.heartbeat(true) })
        timers.append(deps.scheduler.every(1) { [weak self] in self?.tick() })
        timers.append(deps.scheduler.every(0.1) { [weak self] in self?.updateLevels() })
        var realtimeError = ""
        let g = gen
        do { try await startRealtime() } catch {
            guard g == gen, !closed, engineKind == nil else { return }
            realtimeError = error.localizedDescription
            stopRealtime()
            startCascade()
        }
        if closed || g != gen { return }
        render()
        if !realtimeError.isEmpty { basic(realtimeError) }
        earcon("listen")
        uses += 1
        deps.prefs.set(Self.usesKey, String(uses))
        if deps.prefs.get(Self.introKey) == nil {
            deps.prefs.set(Self.introKey, "1")
            tell("I'm listening. Just talk to pi, and say stop any time.",
                 "[PI] This is the developer's first time in voice mode. In one short sentence, say you're listening, they can just talk, and \"stop\" works any time.")
        }
    }

    func restart() async {
        for t in timers { t.cancel() }
        timers = []
        setNote("")
        setState(.connecting)
        await open()
    }

    func wireAudioSession() {
        guard let s = deps?.audioSession else { return }
        s.onInterruption = { [weak self] began in self?.interruption(began) }
        s.onRouteChange = { [weak self] r in self?.route = r }
        s.onInputMute = { [weak self] m in
            guard let self, m != self.muted else { return }
            self.setMuted(m)
        }
        s.onNetworkChange = { [weak self] in self?.networkChanged() }
        // Headset / lock-screen play-pause acts like tapping the circle (web: mediaSession play/pause).
        s.onRemoteToggle = { [weak self] in
            guard let self, self.isOpen, !self.closed else { return }
            self.tap() // push to talk: tap starts and ends the turn, as on the circle
        }
    }

    /// Interruptions (a call, Siri): pause; resume on `.shouldResume`, else wait for a tap.
    func interruption(_ began: Bool?) {
        guard isOpen, !closed else { return }
        switch began {
        case true?:
            interrupted = true
            // Nobody can say "stop" now: an undo window must not go ahead unheard (pi's question stays open).
            dropGrace()
            silence()
            rtc?.micEnabled = false
            clientTurns(false)
            setState(.paused)
        case false?:
            resumeAfterInterruption()
        case nil:
            interrupted = true
            dropGrace()
            setState(.paused)
        }
    }

    func resumeAfterInterruption() {
        if let s = deps?.audioSession {
            do { try s.activate(); audioToken = AudioOwner.shared.claim() } catch {
                // Still interrupted (e.g. a call is on): stay paused; the next tap tries again.
                setNote("The microphone is busy. Tap to resume.")
                return setState(.paused)
            }
        }
        interrupted = false
        setNote("")
        rtc?.micEnabled = !muted && (settings.turns == .open || talking)
        if engineKind == .basic, let io = basicIO {
            // The interruption stopped the capture engine: start it again.
            io.stop()
            do { try io.start { [weak self] samples, rate in self?.onFrame(samples, rate) } } catch {
                setNote("\(error.localizedDescription) Tap the circle to try again.")
                interrupted = true
                return setState(.paused)
            }
        }
        setState(muted ? .paused : listenState())
    }

    /// Network path changed: reopen the event streams and redial the call (no ICE restart through
    /// the computer's endpoint) [verify on a device whether WebRTC alone recovers].
    func networkChanged() {
        guard isOpen, !closed else { return }
        deps?.fleet.reconnect()
        // One redial at a time: a burst of path changes while dialling is the same change.
        guard engineKind == .realtime, redial == nil else { return }
        let g = gen
        redial = Task { [weak self] in
            guard let self else { return }
            defer { if self.gen == g { self.redial = nil } }
            self.stopRealtime()
            self.setState(.connecting)
            do { try await self.startRealtime() } catch {
                // Only this voice mode's own redial may fall back (not a newer call or a closed one).
                guard self.gen == g, !self.closed, self.engineKind == nil else { return }
                self.stopRealtime()
                self.startCascade()
                self.basic(error.localizedDescription)
            }
        }
    }

    func updateLevels() {
        var l = VoiceLevels()
        if let r = rtc {
            l.mine = muted ? 0 : r.micLevel
            l.pi = r.piLevel
        } else if let b = basicIO {
            l.mine = muted ? 0 : min(1, basicLevel * 6)
            if state == .speaking {
                if let o = b.outLevel { l.pi = min(1, o) } else {
                    // The phone's own synthesis can't be measured; a gentle speech-like motion instead.
                    let t = (deps?.ms() ?? 0) / 1000
                    l.pi = 0.25 + 0.2 * abs(sin(t * 7.3) * sin(t * 2.9))
                }
            }
        }
        if l != levels { levels = l }
    }

    // MARK: UI state
    func setState(_ s: VoiceState) {
        state = s
        render()
    }

    func render() {
        now = deps?.now() ?? Date()
        let info = infos[cur]
        sessionName = agentName(cur)
        machineName = several && !machineNameOf(machineId).isEmpty ? machineNameOf(machineId) : nil
        let line = statusLineFor(cur)
        sessionLine = line.text
        sessionStatus = line.cls == "waiting" ? "waiting" : (info?["status"]?.string ?? "gone")
        sessions = infos.keys.filter(reachable).sorted().map { k in
            let (m, a) = split(k)
            return VoiceSessionItem(agent: a, machine: m, name: agentName(k), machineName: several ? machineNameOf(m) : nil,
                                    status: statusOf[k] ?? "", waiting: prompts[k]?.count ?? 0)
        }
        renderAsk()
    }

    /// The app header's status line (`statusLine(info)` in web/app.js).
    func statusLineFor(_ k: String) -> (text: String, cls: String) {
        guard let info = infos[k] else { return ("", "") }
        if let ask = prompts[k]?.first { return ("Needs you · \(ask["title"]?.string ?? "")", "waiting") }
        let st = info["status"]?.string
        if st == "waiting" { return ("Needs you in the terminal", "waiting") }
        if st == "working" {
            var t = "Working"
            if let since = info["since"]?.number { t += " · \(Self.elapsed(now.timeIntervalSince1970 * 1000 - since))" }
            if info["queued"]?.bool == true { t += " · message queued" }
            return (t, "working")
        }
        var bits: [String] = []
        if let task = info["task"]?.string, !task.isEmpty { bits.append(task) } else {
            let parts = (info["cwd"]?.string ?? "").split(separator: "/")
            bits.append(parts.count > 2 ? "…/" + parts.suffix(2).joined(separator: "/") : info["cwd"]?.string ?? "")
        }
        if let pc = info["context"]?["percent"]?.number { bits.append("\(Int(pc.rounded()))% context") }
        if let c = info["cost"]?.number, c > 0 { bits.append(String(format: "$%.2f", c)) }
        return (bits.filter { !$0.isEmpty }.joined(separator: " · "), "")
    }

    static func elapsed(_ ms: Double) -> String {
        let s = max(0, Int(ms / 1000)), h = s / 3600, m = (s % 3600) / 60
        let ss = String(format: "%02d", s % 60)
        return h > 0 ? "\(h):\(String(format: "%02d", m)):\(ss)" : "\(m):\(ss)"
    }

    func setNote(_ text: String) { note = text }

    /// Realtime voice isn't available: say so once, briefly; the settings sheet keeps the reason.
    func basic(_ error: String) {
        if let r = error.range(of: #"^.*unavailable:\s*"#, options: .regularExpression) {
            settings.basicReason = String(error[r.upperBound...])
        } else { settings.basicReason = error }
        let msg = "Using basic voice. Details in voice settings."
        setNote(msg)
        _ = deps?.scheduler.after(8) { [weak self] in if self?.note == msg { self?.setNote("") } }
    }

    func heardCaption(_ text: String, live: Bool = false) { heard = VoiceCaption(text: text, live: live) }
    func saidCaption(_ text: String, live: Bool = false) { said = VoiceCaption(text: text, live: live) }

    /// pi's open question as a card (`renderAsk`).
    func renderAsk() {
        guard let core, let p = openPrompt, let id = p["id"]?.string else {
            if question != nil { question = nil }
            return
        }
        let kind = p["kind"]?.string ?? "input"
        let destructive = core.isDestructive(p)
        var options: [VoiceQuestion.Option] = []
        if kind == "confirm" {
            options.append(.init(label: destructive ? "Yes, do it" : "Yes", value: true, destructive: destructive, primary: !destructive))
            options.append(.init(label: "No", value: false, destructive: false))
        } else if kind == "select" {
            for o in (p["options"]?.array ?? []).prefix(6).compactMap(\.string) {
                options.append(.init(label: o, value: .string(o), destructive: core.isDestructive(["title": .string(o)])))
            }
            options.append(.init(label: "Cancel", value: nil, destructive: false, ghost: true))
        }
        var title = p["title"]?.string ?? ""
        var g: VoiceQuestion.Grace?
        if let gr = grace, gr.prompt["id"]?.string == id {
            g = .init(until: gr.until, total: Self.graceMs / 1000)
            title = title.replacingOccurrences(of: #"\?\s*$"#, with: "", options: .regularExpression)
        }
        let q = VoiceQuestion(id: id, kind: kind, title: title, message: p["message"]?.string, destructive: destructive, options: options, grace: g)
        if q != question { question = q }
    }

    func earcon(_ name: String) { deps?.earcons.play(name) }

    // MARK: turns and mute
    /// Push to talk: starts or ends your turn.
    func toggleTalk() {
        if engineKind == .realtime {
            guard let r = rtc else { return }
            talking.toggle()
            r.micEnabled = talking
            if talking && state == .speaking { hardInterrupt() }
            if !talking {
                rt(["type": "input_audio_buffer.commit"])
                shortTurn = false
                respond()
            }
            earcon(talking ? "listen" : "heard")
            return setState(talking ? .hearing : .thinking)
        }
        manualTurn()
    }

    func setMuted(_ m: Bool) {
        muted = m
        if m {
            clientTurns(false)
            dropGrace() // a muted mic can't hear "stop"
        }
        deps?.audioSession?.setInputMuted(m)
        if !m { setNote("") }
        if engineKind == .realtime { rtc?.micEnabled = !m && (settings.turns == .open || talking) }
        if m { capture = nil }
        earcon(m ? "off" : "listen")
        setState(m ? .paused : listenState())
    }

    func setAttention(_ a: VoiceAttention) {
        guard a != settings.attention else { return }
        settings.attention = a
        deps?.prefs.set(Self.modeKey, a.rawValue)
        heartbeat(true)
        if engineKind == .realtime {
            inject(a == .glance
                ? "[PI] The developer can now glance at the screen. You may be a little more detailed; still no code read aloud."
                : "[PI] The developer cannot look at the screen any more (driving, running or similar). Keep it very short; defer anything visual.", respond: false)
        }
        render()
    }

    func setTurns(_ t: VoiceTurns) {
        guard t != settings.turns else { return }
        settings.turns = t
        talking = false
        if t == .tap { clientTurns(false) }
        deps?.prefs.set(Self.turnKey, t.rawValue)
        if engineKind == .realtime { rtc?.micEnabled = !muted && t == .open }
        setState(muted ? .paused : listenState())
    }

    func listenState() -> VoiceState {
        if muted { return .paused }
        if settings.turns == .tap { return talking ? .hearing : .paused }
        return .listening
    }

    // MARK: pi events
    func onEvent(_ k: String, _ ev: HubEvent, prevStatus prev: String?) {
        guard !closed, let core else { return }
        switch ev.type {
        case "info":
            guard k == cur else { return }
            let st = statusOf[k]
            if st == "working" && prev != "working" { workingSince = deps?.now() ?? Date() }
            if st == "idle", let prev, prev != "idle" { Task { await settled() } }
            return
        case "prompt":
            guard let p = ev.raw["prompt"] else { return }
            earcon("attention")
            if k == cur { return ask(p) }
            let name = sessionLabel(k), title = p["title"]?.string ?? ""
            return tell("\(name) needs you: \(title). Say \"switch to \(name)\" to answer it.", "[PI] Another session, \"\(name)\", asks: \(title). Tell the developer briefly; they can say \"switch to \(name)\".")
        case "prompt_end" where k == cur:
            if let g = grace, g.prompt["id"] == ev.raw["id"] { dropGrace() }
            if ev.raw["by"]?.string == "terminal" && engineKind == .realtime { inject("[PI] That question was answered in the terminal.", respond: false) }
            renderAsk()
            if state == .asking { setState(listenState()) }
            return
        case "gone" where k == cur:
            tell("That session stopped.", "[PI] The session the developer was following stopped.")
        default: break
        }
        // Tool calls are pi's business, except significant ones.
        guard k == cur, let id = ev.raw["id"]?.string else { return }
        if ev.type == "tool_start", let title = ev.raw["title"]?.string, core.isSignificant(title) {
            significant[id] = title
            if engineKind == .realtime { inject("[PI] pi is running a significant action: \(title)", respond: false) }
        }
        if ev.type == "tool_end", let title = significant.removeValue(forKey: id), ev.raw["isError"]?.bool == true {
            earcon("failed")
            tell("Heads-up: a significant action pi ran just failed.", "[PI] A significant action FAILED: \(title). Tell the developer in one sentence what kind of action failed (no command text); pi is still working.")
        }
    }

    func follow(machine: String, agent a: String) {
        let old = (machineId, agent)
        if !old.1.isEmpty, let fleet = deps?.fleet { Task { _ = try? await fleet.agentCall(machine: old.0, agent: old.1, "voiceState", ["on": false]) } }
        machineId = machine
        agent = a
        heartbeat(true)
        optionPage = 0
        render()
        if engineKind == .realtime { inject("[PI] Now following the session \"\(agentName(cur))\". \(statusLine())", respond: false) }
        let k = cur
        Task { [weak self] in
            await self?.deps?.fleet.focus(machine: machine, agent: a)
            await self?.loadPrompts(k)
        }
    }

    func statusLine() -> String {
        guard let info = infos[cur] else { return "" }
        var s = "Status: \(info["status"]?.string ?? "")."
        if let t = info["task"]?.string, !t.isEmpty { s += " Its task: \(t)." }
        if let l = info["last"]?.string, !l.isEmpty { s += " Its latest reply begins: \(l)" }
        return s
    }

    /// Soft working tick every few seconds while pi works and nobody talks: "still on it", eyes-free.
    func tick() {
        now = deps?.now() ?? Date()
        if grace != nil { renderAsk() }
        sessionLine = statusLineFor(cur).text
        guard statusOf[cur] == "working" else {
            if state == .working { setState(listenState()) }
            return
        }
        if state == .listening || (state == .paused && !muted && !interrupted) { setState(.working) }
        if state == .working, now.timeIntervalSince(lastTick) > 6 {
            lastTick = now
            earcon("working")
        }
    }

    func settled() async {
        let b: JSON
        let g = gen
        do {
            b = try await sessionCall("brief", ["mode": .string(settings.attention.rawValue)])
            guard g == gen, !closed else { return }
        } catch {
            guard g == gen, !closed else { return }
            return tell("pi finished, but I couldn't get the summary.", "[PI] pi finished but the summary failed: \(error.localizedDescription)")
        }
        let report = b["report"]?.string ?? ""
        let failed = report.range(of: #"SIGNIFICANT ACTION FAILED|(^|\n)ERROR:"#, options: .regularExpression) != nil
        earcon(failed ? "failed" : "done")
        more = b["more"]?.array?.compactMap(\.string) ?? []
        let speech = b["speech"]?.string ?? ""
        let offer = !more.isEmpty && engineKind == .basic ? " Want \(more[0])?" : ""
        tell(speech + offer,
             "[PI] pi finished.\nSPOKEN BRIEF: \(speech)\n\(more.isEmpty ? "" : "MORE AVAILABLE: \(more.joined(separator: "; ")) (offer at most one, briefly)\n")REPORT (for follow-up questions, do not read out):\n\(report)")
    }

    // MARK: the undo window
    /// What the developer said lately (both engines), to check an earlier request really named an action.
    func rememberHeard(_ text: String, echo: Bool = false) {
        guard !text.isEmpty else { return }
        let t = deps?.now() ?? Date()
        lastHeardEcho = echo
        recentHeard = Array((recentHeard.filter { t.timeIntervalSince($0.at) < 180 } + [(text, t, echo)]).suffix(12))
    }

    /// The claim that an earlier request named this action must hold for something actually heard.
    func namedEarlier(_ prompt: JSON, claimed: String? = nil) -> Bool {
        guard let core, core.isDestructive(prompt) else { return false }
        // Only what was heard in the last 3 minutes (the web keeps no older request) counts.
        let t = deps?.now() ?? Date()
        let heardTexts = recentHeard.filter { !$0.echo && t.timeIntervalSince($0.at) < 180 }.map(\.text)
        return (claimed == nil || claimed!.isEmpty || core.requestNames(prompt: prompt, said: claimed!)) && heardTexts.contains { core.requestNames(prompt: prompt, said: $0) }
    }

    func cancelsGrace(_ text: String) -> Bool {
        guard let core else { return false }
        let cmd = core.parseCommand(text)?.kind
        return cmd == "stop" || cmd == "quiet" || core.norm(text).range(of: #"^(no|nope|cancel|wait|hold on|don't|do not|abort)\b"#, options: .regularExpression) != nil
    }

    /// You asked for this irreversible action by name: go ahead after a few seconds unless you say stop.
    func startGrace(_ prompt: JSON) {
        cancelGrace(quiet: true)
        guard let deps else { return }
        graceSeq += 1
        let id = graceSeq
        // The timer answers only its own window, never a replacement.
        let timer = deps.scheduler.after(Self.graceMs / 1000) { [weak self] in
            guard let self, let w = self.takeGrace(id: id) else { return }
            Task { await self.answerGrace(w, true) }
        }
        grace = (prompt, deps.now().addingTimeInterval(Self.graceMs / 1000), timer, id)
        earcon("attention")
        renderAsk()
    }

    /// Forgets the undo window without answering (answered elsewhere, voice mode ended, nobody listening).
    func dropGrace() {
        grace?.timer.cancel()
        grace = nil
        renderAsk()
    }

    /// Detaches the current window synchronously (optionally only if it is window `id`).
    func takeGrace(id: Int? = nil) -> Grace? {
        guard let g = grace, id == nil || g.id == id else { return nil }
        g.timer.cancel()
        grace = nil
        renderAsk()
        return g
    }

    func answerGrace(_ g: Grace, _ value: Bool) async {
        let mine = gen
        do {
            try await sessionCall("answer", ["id": g.prompt["id"] ?? .null, "value": .bool(value)])
            guard mine == gen else { return }
            earcon(value ? "heard" : "off")
        } catch { if mine == gen { setNote(error.localizedDescription) } }
        renderAsk()
    }

    func finishGrace(_ value: Bool) async {
        guard let g = takeGrace() else { return }
        await answerGrace(g, value)
    }

    func cancelGrace(quiet: Bool) {
        guard let g = takeGrace() else { return }
        let title = g.prompt["title"]?.string ?? ""
        Task { await answerGrace(g, false) }
        if quiet { return }
        silence()
        tell("Cancelled.", "[PI] The developer cancelled: \(title). Say \"Cancelled\" and nothing else.")
    }

    func ask(_ prompt: JSON) {
        guard let core else { return }
        optionPage = 0
        renderAsk()
        let title = prompt["title"]?.string ?? ""
        // You just asked for exactly this by name: go ahead with an undo window instead of asking again.
        if namedEarlier(prompt) {
            startGrace(prompt)
            let what = title.replacingOccurrences(of: #"\?\s*$"#, with: "", options: .regularExpression)
            return tell("\(what): going ahead in a few seconds. Say stop to cancel.",
                        "[PI] pi asks to confirm \"\(title)\". The developer already asked for exactly this, so the phone confirms it in \(Int(Self.graceMs / 1000)) seconds unless they say stop. Say only, in a few words: \"\(what), say stop to cancel.\" Do not call answer_question.")
        }
        let destructive = core.isDestructive(prompt)
        let opts = prompt["options"]?.array?.compactMap(\.string) ?? []
        let optsText = opts.isEmpty ? "" : "\nOptions: " + opts.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "; ")
        let msg = prompt["message"]?.string.map { " — \($0)" } ?? ""
        tell(core.speakPrompt(prompt),
             "[PI] QUESTION (id \(prompt["id"]?.string ?? ""), \(prompt["kind"]?.string ?? "")\(destructive ? ", DESTRUCTIVE: needs explicit confirmation naming the action" : "")): \(title)\(msg)\(optsText)",
             state: .asking)
    }

    /// Speaks to the developer: realtime gets context to say it in its own voice; basic voice speaks `speech`.
    func tell(_ speech: String, _ context: String, state s: VoiceState? = nil) {
        if let s { setState(s) }
        if engineKind == .realtime { return inject(context, respond: true) }
        if engineKind == .basic { speak(speech) }
    }

    func interrupt() {
        if engineKind == .realtime {
            if active { rt(["type": "response.cancel"]) }
            rt(["type": "output_audio_buffer.clear"])
        } else { silence() }
        setState(listenState())
    }

    // MARK: tools (realtime tool calls and basic voice's own intents)
    func tool(_ name: String, _ args: JSON) async throws -> JSON {
        guard let core else { return ["error": "no voice core"] }
        if closed { return ["error": "voice mode ended"] }
        switch name {
        case "ask_pi":
            let text = (args["request"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { return ["error": "empty request"] }
            let r = try await sessionCall("send", ["text": .string(text), "mode": .string(args["when"]?.string == "after" ? "followUp" : "steer")])
            if workingSince == nil { workingSince = deps?.now() ?? Date() }
            let d = r["delivered"]?.string ?? ""
            return ["delivered": .string(d), "note": .string(d == "prompt" ? "pi started working on it" : d == "steer" ? "pi is busy; the request steers its current work" : "queued until pi finishes")]
        case "answer_question":
            let list = prompts[cur] ?? []
            guard let p = list.first(where: { $0["id"] == args["id"] && args["id"] != nil }) ?? list.first else { return ["error": "pi is not waiting on a question"] }
            if lastHeardEcho && core.isDestructive(p) {
                return ["error": "Not answered: the microphone picked up your own voice, not the developer. Ask them, naming the action."]
            }
            let ans: String
            switch args["answer"] { case .string(let s)?: ans = s; case .bool(let b)?: ans = b ? "true" : "false"; case .number(let n)?: ans = String(n); default: ans = "" }
            let r = core.answerFor(prompt: p, text: ans)
            if r.needConfirm != nil, !r.answered, namedEarlier(p, claimed: args["earlier_request"]?.string) {
                startGrace(p)
                return ["pending": .string("Confirming in \(Int(Self.graceMs / 1000)) seconds unless the developer says stop. Tell them in a few words that it is going ahead and that stop cancels.")]
            }
            if let w = r.needConfirm { return ["error": .string("Not answered: this is an irreversible action. Ask the developer to confirm by saying \"yes, \(w)\".")] }
            if r.unclear { return ["error": "Not answered: the answer does not fit the question. Ask again briefly."] }
            var params: [String: JSON] = ["id": p["id"] ?? .null]
            if let v = r.value { params["value"] = v }
            try await sessionCall("answer", .object(params))
            return ["answered": r.value ?? "cancelled"]
        case "stop_pi":
            try await sessionCall("abort", [:])
            return ["stopped": true]
        case "pi_status":
            return try await sessionCall("voiceStatus", [:])
        case "pi_details":
            return try await sessionCall("details", ["topic": .string(args["topic"]?.string ?? ""), "mode": .string(settings.attention.rawValue)])
        case "switch_session":
            let keys = infos.keys.filter(reachable).sorted()
            let machineLabel = { (k: String) in self.several ? self.machineNameOf(self.split(k).machine) : "" }
            let list: [JSON] = keys.map { k in
                let i = infos[k] ?? [:]
                return ["agent": .string(k), "name": i["name"] ?? "", "cwd": i["cwd"] ?? "", "task": i["task"] ?? "", "status": i["status"] ?? "", "machine": .string(machineLabel(k))]
            }
            let brief = { (k: String) -> JSON in
                var o: [String: JSON] = ["name": self.infos[k]?["name"] ?? "", "status": self.infos[k]?["status"] ?? "", "task": self.infos[k]?["task"] ?? .null, "waiting": .number(Double(self.prompts[k]?.count ?? 0))]
                if !machineLabel(k).isEmpty { o["machine"] = .string(machineLabel(k)) }
                return .object(o)
            }
            let said = args["name"]?.string ?? ""
            let q = core.norm(said)
            if q.isEmpty || q == "list" || q == "sessions" { return ["sessions": .array(keys.map(brief))] }
            switch core.matchSession(list, q) {
            case .ambiguous(let ix): return ["ambiguous": .array(ix.map { brief(keys[$0]) }), "say": "Ask which computer they mean."]
            case .none:
                return ["error": .string("no session matches \"\(said)\""), "sessions": .array(keys.map { k in .string(machineLabel(k).isEmpty ? agentName(k) : "\(agentName(k)) on \(machineLabel(k))") })]
            case .match(let i):
                let k = keys[i], (m, a) = split(k)
                follow(machine: m, agent: a)
                return ["switched": .string(sessionLabel(k)), "status": infos[k]?["status"] ?? "", "waiting": .number(Double(prompts[k]?.count ?? 0))]
            }
        case "remain_silent":
            return ["ok": true]
        default:
            return ["error": .string("unknown tool \(name)")]
        }
    }

    // MARK: realtime engine
    func startRealtime() async throws {
        guard let deps else { return }
        let r = deps.makeRealtime()
        rtc = r
        r.micEnabled = !muted && (settings.turns == .open || talking)
        r.onEvent = { [weak self, weak r] ev in
            guard let self, let r, self.rtc === r else { return }
            self.onRealtime(ev)
        }
        r.onLost = { [weak self, weak r] in
            guard let self, let r, self.rtc === r, !self.closed, self.engineKind == .realtime else { return }
            self.realtimeLost()
        }
        active = false
        wantResponse = false
        userSpeaking = false
        calls = []
        var params: [String: JSON] = ["mode": .string(settings.attention.rawValue)]
        if let p = deps.prefs.get(Self.personaKey) { params["persona"] = .string(p) }
        try await r.connect { [weak self] sdp in
            guard let self else { throw HubError.network("closed") }
            params["sdp"] = .string(sdp)
            let res = try await self.speechCall("voiceSession", .object(params))
            guard let answer = res["sdp"]?.string else { throw HubError.remote("realtime unavailable: no answer") }
            return answer
        }
        guard rtc === r, !closed else { throw HubError.network("closed") }
        engineKind = .realtime
        inject("[PI] Voice mode started. The developer is following the session \"\(agentName(cur))\". \(statusLine()) Do not greet; wait for them to speak.", respond: false)
        setState(listenState())
        if let p = openPrompt { ask(p) }
    }

    func realtimeLost() {
        stopRealtime()
        setNote("Realtime voice dropped; continuing with basic voice.")
        earcon("failed")
        startCascade()
    }

    func stopRealtime() {
        clientVad?.cancel()
        clientVad = nil
        rtc?.onEvent = nil
        rtc?.onLost = nil
        rtc?.close()
        rtc = nil
        if engineKind == .realtime { engineKind = nil }
    }

    func rt(_ ev: JSON) { rtc?.send(ev) }

    func inject(_ text: String, respond r: Bool) {
        rt(["type": "conversation.item.create", "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": .string(text)]]]])
        if r { respond() }
    }

    /// response.create, deferred while a response is active or the developer is talking.
    func respond() {
        if active || userSpeaking {
            wantResponse = true
            return
        }
        wantResponse = false
        active = true
        rt(["type": "response.create"])
    }

    /// Turn-taking while pi speaks, done on the phone: server VAD off, pi ducks at your first sound,
    /// stops after `bargeMs` of voiced speech; shorter sounds are committed and judged by transcript.
    func clientTurns(_ wanted: Bool) {
        var on = wanted
        if engineKind != .realtime || settings.turns != .open || muted { on = false }
        if on == (clientVad != nil) { return }
        if on {
            rt(["type": "session.update", "session": ["type": "realtime", "audio": ["input": ["turn_detection": .null]]]])
            cvad = core?.vad(hangMs: 800, minSpeechMs: 120)
            cturn = nil
            clientVad = deps?.scheduler.every(0.02) { [weak self] in self?.clientVadFrame() }
            return
        }
        clientVad?.cancel()
        clientVad = nil
        cturn = nil
        if let st = serverTurns { rt(["type": "session.update", "session": ["type": "realtime", "audio": ["input": ["turn_detection": st]]]]) }
    }

    /// One 20 ms frame of the client VAD. The level comes from WebRTC stats [verify against device AEC].
    func clientVadFrame() {
        guard let v = cvad, let deps else { return }
        let rms = rtc?.micRaw ?? 0
        let speaking = state == .speaking
        // Echo cancellation is good, not perfect: over pi's voice only clearly louder speech counts.
        v.setGain(speaking ? 3 : 1)
        let e = v.feed(rms, deps.ms())
        if e == "start" {
            cturn = (0, false)
            overlap = speaking
            if speaking { duck() }
        }
        if var t = cturn, rms > v.threshold() {
            t.voiced += 20
            if !t.interrupted && t.voiced >= Self.bargeMs {
                t.interrupted = true
                cturn = t
                if state == .speaking { hardInterrupt() } else { setState(.hearing) }
            }
            cturn = t
        }
        if e == "end", let t = cturn {
            cturn = nil
            if t.interrupted || state != .speaking {
                rt(["type": "input_audio_buffer.commit"])
                shortTurn = !t.interrupted && t.voiced < 600
                setState(.thinking)
                if !shortTurn {
                    earcon("heard")
                    respond()
                }
                clientTurns(false)
            } else {
                // Short and over pi: commit it for its words while pi stays ducked; the transcript decides.
                rt(["type": "input_audio_buffer.commit"])
                shortTurn = true
            }
        }
    }

    /// Lowers pi's voice while it finds out whether you are taking the turn.
    func duck() {
        rtc?.remoteVolume = 0.2
        basicIO?.setDucked(true)
        ducked = true
    }

    func unduck() {
        guard ducked else { return }
        ducked = false
        rtc?.remoteVolume = 1
        basicIO?.setDucked(false)
    }

    /// You took the turn: pi stops talking.
    func hardInterrupt() {
        ducked = false
        if engineKind == .realtime {
            // The response may be fully generated while its audio still plays: cancel only a live one.
            if active { rt(["type": "response.cancel"]) }
            rt(["type": "output_audio_buffer.clear"])
            rtc?.remoteVolume = 1
        } else { silence() }
        setState(.hearing)
    }

    func onRealtime(_ ev: JSON) {
        guard let core, let deps else { return }
        switch ev["type"]?.string ?? "" {
        case "session.updated":
            if let td = ev["session"]?["audio"]?["input"]?["turn_detection"], !td.isNull, serverTurns == nil { serverTurns = td }
        case "input_audio_buffer.speech_started":
            userSpeaking = true
            turnStart = deps.ms()
            overlap = false
            heardLive = ""
            heardCaption("", live: true)
            setState(.hearing)
        case "conversation.item.input_audio_transcription.delta":
            heardLive += ev["delta"]?.string ?? ""
            heardCaption(heardLive, live: true)
        case "response.output_audio_transcript.delta":
            let d = ev["delta"]?.string ?? ""
            // A second spoken part in the same response starts a new sentence.
            if let last = saidLive.last, ".!?".contains(last), let f = d.first, !f.isWhitespace { saidLive += " " }
            saidLive += d
            saidCaption(saidLive, live: true)
        case "input_audio_buffer.speech_stopped":
            userSpeaking = false
            let dur = deps.ms() - turnStart
            // A long turn is a turn: reply now. A short one waits for its words ("stop" or "mm-hmm"?).
            shortTurn = dur < Self.shortTurnMs
            setState(.thinking)
            if !shortTurn {
                earcon("heard")
                respond()
            }
            if wantResponse && !active { respond() }
        case "conversation.item.input_audio_transcription.completed":
            let text = (ev["transcript"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            heardLive = ""
            heardCaption(text)
            let echo = overlap && core.isEcho(text, "\(lastSpoken) \(saidLive)")
            rememberHeard(text, echo: echo)
            // "Stop" during an undo window cancels the confirmation, not pi's work.
            if grace != nil && !echo && cancelsGrace(text) {
                shortTurn = false
                if state == .speaking { hardInterrupt() }
                unduck()
                cancelGrace()
                return
            }
            if shortTurn {
                shortTurn = false
                // Listening noises, coughs and pi's own voice are not turns: pi carries on.
                if echo || core.isBackchannel(text, answering: answering) {
                    unduck()
                    if state == .thinking || state == .hearing { setState(listenState()) }
                    return
                }
                if state == .speaking { hardInterrupt() }
                earcon("heard")
                respond()
            }
            let cmd = core.parseCommand(text)?.kind
            // Instant local stop, before the model has even answered; its own stop_pi is then a no-op.
            if cmd == "stop" && statusOf[cur] == "working" { Task { try? await sessionCall("abort", [:]) } }
            if cmd == "end" { _ = deps.scheduler.after(1.2) { [weak self] in self?.stop() } }
            if !echo, let cmd, core.settings.contains(cmd), let s = VoiceSetting(rawValue: cmd) { applySetting(s) }
        case "response.created":
            active = true
            saidLive = ""
        case "output_audio_buffer.started":
            setState(.speaking)
            clientTurns(true)
        case "output_audio_buffer.stopped", "output_audio_buffer.cleared":
            if state == .speaking { setState(answering ? .asking : listenState()) }
            if cturn == nil { clientTurns(false) }
        case "response.output_audio_transcript.done":
            lastSpoken = ev["transcript"]?.string ?? ""
            saidLive = ""
            saidCaption(lastSpoken)
        case "response.function_call_arguments.done":
            // Handing a request to pi needs no words: the working sound says it.
            let name = ev["name"]?.string ?? ""
            if name == "ask_pi" { rt(["type": "output_audio_buffer.clear"]) }
            Task { await runCall(ev["call_id"]?.string, name, ev["arguments"]?.string) }
        case "response.done":
            active = false
            if ev["response"]?["status"]?.string == "failed" { setNote("Voice: \(ev["response"]?["status_details"]?["error"]?["message"]?.string ?? "response failed")") }
            if state == .thinking { setState(listenState()) }
            if wantResponse { respond() }
        case "error":
            let msg = ev["error"]?["message"]?.string ?? ""
            if msg.range(of: "no active response|cancel", options: [.regularExpression, .caseInsensitive]) == nil { setNote("Voice: \(msg.isEmpty ? "error" : msg)") }
            if msg.range(of: "active response", options: .caseInsensitive) != nil { wantResponse = true }
        default: break
        }
    }

    func runCall(_ callId: String?, _ name: String, _ rawArgs: String?) async {
        guard let callId, !calls.contains(callId) else { return }
        calls.insert(callId)
        let args = (try? JSON.parse(Data((rawArgs ?? "{}").utf8))) ?? [:]
        var out: JSON
        let g = gen
        do { out = try await tool(name, args) } catch { out = ["error": .string(error.localizedDescription)] }
        guard g == gen, !closed else { return }
        let text = (try? String(data: out.data(), encoding: .utf8)) ?? "{}"
        rt(["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": .string(callId), "output": .string(text)]])
        if name == "ask_pi" && out["error"] == nil {
            // Delegated: say nothing more unless it was queued; the working tick tells them pi is on it.
            if out["delivered"]?.string != "prompt" { respond() } else { setState(.working) }
            return
        }
        if name != "remain_silent" { respond() }
    }

    // MARK: basic voice (cascade): VAD on the phone, recognition on the computer, speech here
    func startCascade() {
        guard let deps else { return }
        engineKind = .basic
        let io = basicIO ?? deps.makeBasic()
        basicIO = io
        vad = core?.vad(hangMs: settings.attention == .eyesBusy ? 1100 : 900)
        pre = []
        capture = nil
        pendingText = ""
        do {
            try io.start { [weak self] samples, rate in self?.onFrame(samples, rate) }
        } catch {
            setNote("\(error.localizedDescription) Tap the circle to try again.")
        }
        setState(listenState())
        if let p = openPrompt { ask(p) }
    }

    func stopCascade() {
        basicIO?.stop()
        if engineKind == .basic { engineKind = nil }
    }

    func onFrame(_ frame: [Float], _ sampleRate: Double) {
        guard !closed, let deps, let vad else { return }
        rate = sampleRate
        var sum: Float = 0
        for x in frame { sum += x * x }
        let rms = Double(frame.isEmpty ? 0 : sqrt(sum / Float(frame.count)))
        basicLevel = rms
        if capture != nil { capture!.append(frame) } else {
            pre.append(frame)
            if pre.count > 6 { pre.removeFirst() }
        }
        if manual { return }
        if settings.turns == .tap || state == .thinking || state == .paused || muted { return }
        // While our own voice plays, only clearly louder speech counts (echo cancellation is not perfect).
        vad.setGain(state == .speaking ? 4 : 1)
        let ev = vad.feed(rms, deps.ms())
        // While ducked: count voiced time, not elapsed time.
        if ducked && rms > vad.threshold() {
            voicedMs += Double(frame.count) / rate * 1000
            if voicedMs >= Self.bargeMs { hardInterrupt() }
        }
        if ev == "start" {
            // Soft barge-in, as in realtime: duck now, stop only if the speech goes on.
            overlap = state == .speaking
            if overlap {
                duck()
                voicedMs = 0
            }
            continueTimer?.cancel()
            if capture == nil { capture = pre }
            setState(.hearing)
        } else if ev == "end", capture != nil {
            Task { await endTurn() }
        }
    }

    func manualTurn() {
        if !manual {
            silence()
            manual = true
            talking = true
            capture = pre
            earcon("listen")
            return setState(.hearing)
        }
        manual = false
        talking = false
        Task { await endTurn() }
    }

    func endTurn() async {
        guard let core else { return }
        let frames = capture ?? []
        capture = nil
        let all = frames.flatMap { $0 }
        if Double(all.count) < rate * 0.35 {
            if ducked {
                unduck()
                return setState(.speaking)
            }
            return setState(listenState())
        }
        earcon("heard")
        setState(.thinking)
        let audio = BasicVoice.wav(BasicVoice.downsample(all, from: rate), rate: 16000)
        var text = ""
        let g = gen
        do {
            let r = try await speechCall("transcribe", ["audio": .string(audio.base64EncodedString()), "mime": "audio/wav", "distill": false])
            guard g == gen, !closed else { return }
            text = (r["raw"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            guard g == gen, !closed else { return }
            setNote("Recognition failed: \(error.localizedDescription)")
            earcon("failed")
            return setState(listenState())
        }
        if text.isEmpty { return setState(listenState()) }
        text = "\(pendingText) \(text)".trimmingCharacters(in: .whitespaces)
        // Over pi's voice: a listening noise, a cough or pi's own echo is not a turn; pi carries on.
        if ducked {
            if core.isEcho(text, lastSpoken) || core.isBackchannel(text, answering: answering) {
                unduck()
                return setState(.speaking)
            }
            hardInterrupt()
        }
        heardCaption(text)
        // Trailing "and…" / "um": wait a moment for the rest of the thought.
        if core.incomplete(text) && !manual && settings.turns == .open {
            pendingText = text
            setState(.listening)
            continueTimer = deps?.scheduler.after(2.2) { [weak self] in
                guard let self else { return }
                let t = self.pendingText
                self.pendingText = ""
                if !t.isEmpty { Task { await self.handleUtterance(t) } }
            }
            return
        }
        pendingText = ""
        await handleUtterance(text)
    }

    /// Basic voice's own conversation logic: commands, answers to dialogs, then requests to pi.
    func handleUtterance(_ text: String) async {
        guard let core, !closed else { return }
        let g = gen
        rememberHeard(text)
        do {
            let cmd = core.parseCommand(text)?.kind
            if grace != nil && cancelsGrace(text) { return cancelGrace() }
            if cmd == "end" { return stop() }
            if cmd == "help" { return speak(core.help) }
            if cmd == "stop" {
                _ = try await tool("stop_pi", [:])
                try alive(g)
                return speak("Stopped.")
            }
            if cmd == "quiet" { return setState(listenState()) }
            if cmd == "repeat" { return speak(lastSpoken.isEmpty ? "I haven't said anything yet." : lastSpoken) }
            if cmd == "status" {
                let s = try await tool("pi_status", [:])["speech"]?.string ?? ""
                try alive(g)
                return speak(s)
            }
            if let cmd, core.settings.contains(cmd), let s = VoiceSetting(rawValue: cmd) {
                applySetting(s)
                return speak(s == .pushToTalk ? "Push to talk. Hold the circle while you talk." : s == .openMic ? "Open mic." : "Okay.")
            }
            if cmd == "shorter" {
                settings.attention = .eyesBusy
                render()
                return speak("Okay, shorter.")
            }
            let n = core.norm(text)
            if let p = openPrompt {
                if n.contains("more options") && p["kind"]?.string == "select" {
                    optionPage += 1
                    return speak(core.speakPrompt(p, page: optionPage))
                }
                let r = core.answerFor(prompt: p, text: text)
                if let w = r.needConfirm { return speak("To be safe: say \"yes, \(w)\" to go ahead, or no.") }
                if !r.unclear {
                    var params: [String: JSON] = ["id": p["id"] ?? .null]
                    if let v = r.value { params["value"] = v }
                    try await sessionCall("answer", .object(params))
                    try alive(g)
                    return speak(r.value == .bool(false) ? "Okay, no." : r.value == nil ? "Cancelled." : "Okay.")
                }
                if p["kind"]?.string != "input" && text.split(separator: " ").count < 4 { return speak("Sorry. \(core.speakPrompt(p, page: optionPage))") }
            }
            if (cmd == "more" || n.range(of: #"^(yes|yeah|sure|ok|okay)\b"#, options: .regularExpression) != nil) && !more.isEmpty {
                let topic = more.removeFirst()
                let s = try await tool("pi_details", ["topic": .string(topic)])["speech"]?.string ?? ""
                try alive(g)
                return speak(s)
            }
            if cmd == "more" { return speak("That's all I have.") }
            if let m = n.firstMatch(of: /^(?:switch to|go to|open)\s+(.+)$/) {
                let name = String(m.1)
                let r = try await tool("switch_session", ["name": .string(name)])
                try alive(g)
                if let amb = r["ambiguous"]?.array { return speak("On which computer? \(amb.compactMap { $0["machine"]?.string }.joined(separator: ", or ")).") }
                return speak(r["error"] != nil ? "I can't find \(name)." : "Now on \(r["switched"]?.string ?? name)\((r["waiting"]?.number ?? 0) > 0 ? ". It has a question for you" : "").")
            }
            // A request for pi: distil it into what was meant, then send.
            var request = text
            if let d = try? await sessionCall("distill", ["raw": .string(text)]), let t = d["text"]?.string, !t.isEmpty { request = d["editor"]?.string ?? t }
            // Voice mode may have ended while distilling: never send a request after End.
            try alive(g)
            let r = try await tool("ask_pi", ["request": .string(request)])
            try alive(g)
            if let e = r["error"]?.string { return speak("I couldn't send that: \(e)") }
            more = []
            if r["delivered"]?.string == "prompt" { return setState(.working) }
            return speak(r["delivered"]?.string == "steer" ? "Passed on." : "Queued for after this.")
        } catch {
            guard g == gen, !closed else { return }
            earcon("failed")
            speak("Something went wrong: \(error.localizedDescription)")
        }
    }

    struct Stale: Error {}
    /// Throws when voice mode ended (or restarted) since generation `g`.
    func alive(_ g: Int) throws { if g != gen || closed { throw Stale() } }

    /// Stops whatever is speaking: the computer's audio or the phone's synthesis.
    func silence() { basicIO?.silence() }

    /// Speaks with the computer's voice when it has one, else the phone's.
    func speak(_ text: String) {
        guard let core else { return }
        let parts = core.chunks(text)
        if parts.isEmpty { return setState(listenState()) }
        lastSpoken = text
        saidCaption(text)
        silence()
        speakTurn += 1
        let turn = speakTurn
        let afterSpeech: @MainActor @Sendable () -> Void = { [weak self] in
            guard let self, self.state == .speaking else { return }
            self.setState(self.answering ? .asking : self.listenState())
        }
        Task { [weak self] in
            guard let self else { return }
            if self.serverTts != false {
                do {
                    var p: [String: JSON] = ["text": .string(text)]
                    if let id = self.deps?.prefs.get(Self.personaKey) { p["persona"] = .string(id) }
                    let r = try await self.speechCall("speak", .object(p))
                    guard turn == self.speakTurn, !self.closed else { return }
                    if let b64 = r["audio"]?.string, let data = Data(base64Encoded: b64), let io = self.basicIO {
                        try io.play(data, mime: r["mime"]?.string ?? "audio/mpeg") { afterSpeech() }
                        self.setState(.speaking)
                        return
                    }
                } catch {
                    if turn != self.speakTurn { return }
                    // Not configured: stop asking. Other failures: this time only.
                    if error.localizedDescription.contains("tts unavailable") { self.serverTts = false }
                }
            }
            guard turn == self.speakTurn, !self.closed else { return }
            self.speakLocal(parts, done: afterSpeech)
        }
    }

    func speakLocal(_ parts: [String], done: @escaping @MainActor () -> Void) {
        let persona = currentPersona
        setState(.speaking)
        basicIO?.speakLocal(parts, persona: persona, rate: (settings.attention == .eyesBusy ? 1.05 : 1.0) * (persona?.rate ?? 1), done: done)
    }
}
