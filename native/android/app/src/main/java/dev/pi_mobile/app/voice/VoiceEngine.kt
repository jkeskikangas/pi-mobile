package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.EmptyObject
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.HubEvent
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.array
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.double
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.int
import dev.pi_mobile.app.core.jsonOf
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Base64
import java.util.Locale
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.properties.ReadWriteProperty
import kotlin.reflect.KProperty

/**
 * Native voice mode: port of `web/voice.js` `class VoiceMode` by way of native/ios/Pi/Voice/VoiceEngine.swift
 * (plans/native-apps.md §7, plans/native-android.md Step 3). The UI collects [ui] and [levels] and calls the
 * intent methods; the rest is internal (the tests drive it).
 *
 * Confinement: every method runs on the thread of [scope]'s dispatcher (Dispatchers.Main in the app, the
 * test dispatcher in tests), as the Swift engine is `@MainActor`; ports call back on that thread too. Async
 * work is launched on [scope] and checks [gen] after each suspension: a newer start or a stop wins.
 */
class VoiceEngine(private val scope: CoroutineScope, deps: VoiceDeps? = null) {
    private val _ui = MutableStateFlow(VoiceUiState())
    /** What the voice screen shows. */
    val ui: StateFlow<VoiceUiState> = _ui.asStateFlow()
    private val _levels = MutableStateFlow(VoiceLevels())
    /** Mic and pi levels, ~10 Hz while open (kept apart from [ui] so the screen doesn't re-render for them). */
    val levels: StateFlow<VoiceLevels> = _levels.asStateFlow()

    /** Called once voice mode has closed (the bridge then calls `window.PiNative.voiceClosed()`). */
    var onClose: (() -> Unit)? = null

    // Observable surface: each property reads and writes its field of [ui].
    var isOpen by uiField({ isOpen }) { copy(isOpen = it) }
        private set
    var state by uiField({ state }) { copy(state = it) }
        private set
    var engineKind by uiField({ engineKind }) { copy(engineKind = it) }
        private set
    var heard by uiField({ heard }) { copy(heard = it) }
        private set
    var said by uiField({ said }) { copy(said = it) }
        private set
    var note by uiField({ note }) { copy(note = it) }
        private set
    var question by uiField({ question }) { copy(question = it) }
        private set
    var muted by uiField({ muted }) { copy(muted = it) }
        private set
    var talking by uiField({ talking }) { copy(talking = it) }
        private set
    var holding by uiField({ holding }) { copy(holding = it) }
        private set
    var agent by uiField({ agent }) { copy(agent = it) }
        private set
    var machineId by uiField({ machineId }) { copy(machineId = it) }
        private set
    var sessionName by uiField({ sessionName }) { copy(sessionName = it) }
        private set
    var machineName by uiField({ machineName }) { copy(machineName = it) }
        private set
    var sessionLine by uiField({ sessionLine }) { copy(sessionLine = it) }
        private set
    var sessionStatus by uiField({ sessionStatus }) { copy(sessionStatus = it) }
        private set
    var route by uiField({ route }) { copy(route = it) }
        private set
    var settings by uiField({ settings }) { copy(settings = it) }
        private set
    var sessions by uiField({ sessions }) { copy(sessions = it) }
        private set
    var workingSince by uiField({ workingSince }) { copy(workingSince = it) }
        private set
    var uses by uiField({ uses }) { copy(uses = it) }
        private set
    var now by uiField({ now }) { copy(now = it) }
        private set

    val label: String get() = _ui.value.label
    val hint: String get() = _ui.value.hint
    val stageAction: String get() = _ui.value.stageAction

    private fun <T> uiField(read: VoiceUiState.() -> T, write: VoiceUiState.(T) -> VoiceUiState) =
        object : ReadWriteProperty<Any?, T> {
            override fun getValue(thisRef: Any?, property: KProperty<*>): T = _ui.value.read()
            override fun setValue(thisRef: Any?, property: KProperty<*>, value: T) = _ui.update { it.write(value) }
        }

    // region public actions

    /** Opens voice mode on a session (`open`). If already open, follows [agent] instead. */
    suspend fun start(agent: String, machine: String) {
        if (isOpen && !closed) {
            if (key(machine, agent) != cur) follow(machine, agent)
            return
        }
        val deps = deps ?: run {
            isOpen = true
            this.agent = agent
            machineId = machine
            return
        }
        closed = false
        gen += 1
        isOpen = true
        state = VoiceState.CONNECTING
        engineKind = null
        heard = VoiceCaption()
        said = VoiceCaption()
        note = ""
        muted = false
        talking = false
        holding = false
        interrupted = false
        workingSince = null
        resetConversation()
        this.agent = agent
        machineId = machine
        speechMachine = null
        settings = settings.copy(
            attention = if (deps.prefs[MODE_KEY] == "glance") VoiceAttention.GLANCE else VoiceAttention.EYES_BUSY,
            turns = if (deps.prefs[TURN_KEY] == "tap") VoiceTurns.TAP else VoiceTurns.OPEN,
            persona = deps.prefs[PERSONA_KEY] ?: settings.persona,
        )
        uses = deps.prefs[USES_KEY]?.toIntOrNull() ?: 0
        wireAudioSession()
        listen()
        val g = gen
        loadWorld()
        if (closed || g != gen) return
        // A hub too old for native voice: say so on screen, don't half-work.
        if (machineId in incompatible) {
            val name = machineNameOf(machineId).ifEmpty { "that computer" }
            setNote("Voice mode needs a newer pi-mobile on $name. Update it there, then try again.")
            earcon("failed")
            return setState(VoiceState.PAUSED)
        }
        loadPersonas()
        open()
    }

    /** Ends voice mode (`close`). */
    fun stop() {
        if (!isOpen || closed) return
        closed = true
        gen += 1
        val deps = deps
        // Mute ends with the session (End button, notification, intent, error): the app-wide input mute
        // would otherwise silence every later dictation (issue #3).
        if (muted || deps?.audioSession?.isInputMuted == true) deps?.audioSession?.setInputMuted(false)
        muted = false
        dropGrace() // pi's question stays open in the app and the terminal
        deps?.earcons?.play("off")
        if (deps != null && agent.isNotEmpty()) {
            val (m, a, mode) = Triple(machineId, agent, settings.attention.raw)
            scope.launch { catching { deps.fleet.agentCall(m, a, "voiceState", obj("on" to false, "mode" to mode)) } }
        }
        timers.forEach { it.cancel() }
        timers.clear()
        stopRealtime()
        stopCascade()
        silence()
        clientVad?.cancel()
        clientVad = null
        continueTimer?.cancel()
        continueTimer = null
        redial?.cancel()
        redial = null
        updatesJob?.cancel()
        updatesJob = null
        _levels.value = VoiceLevels()
        isOpen = false
        // Let the "off" earcon play out, then release the audio session (unless voice mode reopened).
        val g = gen
        if (deps != null) {
            deps.scheduler.after(0.35) {
                if (gen != g) return@after
                deps.earcons.stop()
                // Dictation may have taken the session in the meantime: then it isn't ours to release.
                if (AudioOwner.owns(audioToken)) deps.audioSession?.deactivate()
                audioToken = null
            }
        }
        onClose?.invoke()
    }

    /** Push to talk: pressing the circle starts your turn at once, over pi if it is talking. */
    fun pressStart(): Boolean {
        if (settings.turns != VoiceTurns.TAP || engineKind == null || muted || talking) return false
        holding = true
        toggleTalk()
        return true
    }

    /** Letting go after a hold ends the turn; after a quick tap you stay talking until the next tap. */
    fun pressEnd(held: Boolean) {
        holding = false
        if (held && talking) toggleTalk() else render()
    }

    /** The stage: interrupt pi speaking; otherwise unmute, or (tap to talk) take and give back the floor. */
    fun tap() {
        if (interrupted) return resumeAfterInterruption()
        if (engineKind == null) {
            if (state != VoiceState.CONNECTING) scope.launch { restart() }
            return
        }
        if (state == VoiceState.SPEAKING) return interrupt()
        if (muted) return setMuted(false)
        if (settings.turns == VoiceTurns.TAP) return toggleTalk()
        if (engineKind == VoiceEngineKind.BASIC && state == VoiceState.PAUSED) return setState(VoiceState.LISTENING)
        earcon("listen")
    }

    fun toggleMute() = setMuted(!muted)

    /** A tap on the question card (`renderAsk` → answer). */
    suspend fun answer(option: VoiceQuestion.Option) {
        val id = question?.id ?: return
        answer(option, id)
    }

    /** Answers only if [questionId] is still pi's open question (a tap on a card that changed is rejected). */
    suspend fun answer(option: VoiceQuestion.Option, questionId: String): Boolean {
        val p = openPrompt
        if (closed || p == null || p["id"].string != questionId || grace != null) return false
        val g = gen
        return try {
            sessionCall("answer", answerParams(p, option.value))
            if (g != gen || closed) return true
            if (engineKind == VoiceEngineKind.REALTIME) inject("[PI] The developer answered on screen: ${option.label}. Do not ask again.", respond = false)
            silence()
            if (engineKind == VoiceEngineKind.REALTIME && active) rt(obj("type" to "response.cancel"))
            earcon("heard")
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (g == gen && !closed) setNote(e.text)
            false
        }
    }

    /** Cancels the undo window: pi's question is answered no. */
    fun cancelGrace() = cancelGrace(quiet = false)

    /** "Do it now" during the undo window. */
    suspend fun doItNow() = finishGrace(true)

    /** A new voice. A realtime call keeps its voice once it has spoken, so it is redialled; basic voice just uses it. */
    suspend fun setPersona(id: String) {
        settings = settings.copy(persona = id)
        deps?.prefs?.set(PERSONA_KEY, id)
        render()
        val p = currentPersona
        if (engineKind == VoiceEngineKind.BASIC) return speak(sampleLine(p))
        if (engineKind != VoiceEngineKind.REALTIME) return
        val g = gen
        stopRealtime()
        setState(VoiceState.CONNECTING)
        try {
            startRealtime()
            if (g != gen || closed) return
            inject("[PI] The developer just picked a new voice for you. Say only one short sentence in it: \"This is ${p?.name ?: "me"}.\"", respond = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Ended (or reopened) while redialling: no fallback, no mic.
            if (g != gen || closed || engineKind != null) return
            stopRealtime()
            startCascade()
            render()
            basic(e.text)
            speak(sampleLine(p))
        }
    }

    /** "Push to talk", "open mic", "eyes free", "I can glance": settings by voice or the sheet. */
    fun applySetting(setting: VoiceSetting) {
        when (setting) {
            VoiceSetting.PUSH_TO_TALK -> setTurns(VoiceTurns.TAP)
            VoiceSetting.OPEN_MIC -> setTurns(VoiceTurns.OPEN)
            VoiceSetting.EYES_FREE -> setAttention(VoiceAttention.EYES_BUSY)
            VoiceSetting.GLANCE -> setAttention(VoiceAttention.GLANCE)
        }
        earcon("heard")
    }

    /** Follow another session (switcher). Keeps the call. */
    fun switchSession(agent: String, machine: String) {
        if (key(machine, agent) == cur) return
        follow(machine, agent)
    }

    /** Previews and screenshot tests: show any state with sample captions (`PiVoice.preview`). Sets `isOpen`. */
    fun preview(change: VoiceUiState.() -> VoiceUiState) = _ui.update { it.change().copy(isOpen = true) }

    /** Gives the app's single engine its live parts before `start` (ignored while open). */
    fun attach(d: VoiceDeps) {
        if (isOpen && !closed) return
        deps = d
    }

    // endregion

    companion object {
        val LABELS: Map<VoiceState, String> = mapOf(
            VoiceState.CONNECTING to "Connecting…", VoiceState.LISTENING to "Listening", VoiceState.HEARING to "Listening…",
            VoiceState.THINKING to "Got it", VoiceState.WORKING to "pi is on it", VoiceState.SPEAKING to "",
            VoiceState.ASKING to "pi needs you", VoiceState.PAUSED to "Mic off", VoiceState.OFFLINE to "Reconnecting…",
        )

        // web/voice.js
        const val MODE_KEY = "pi-mobile-voice-attention"
        const val TURN_KEY = "pi-mobile-voice-turns"
        const val PERSONA_KEY = "pi-mobile-voice-persona"
        const val USES_KEY = "pi-mobile-voice-uses"
        const val INTRO_KEY = "pi-mobile-voice-intro"
        const val GRACE_MS = 4000.0
        /** Voiced speech over pi that takes the turn (Hume's default); pi ducks at once meanwhile. */
        const val BARGE_MS = 800.0
        /** Turns shorter than this (server-measured) wait for their words. */
        const val SHORT_TURN_MS = 1300.0
        const val HOLD_MS = 350.0

        fun sampleLine(p: VoicePersona?) = "This is ${p?.name ?: "pi"}. The tests pass, and the change is ready for you to review."

        /** What native voice needs from a hub (`hub` rpc `protocol` and `features`, plan Step 1). */
        const val PROTOCOL_VERSION = 1
        val NEEDED_FEATURES = listOf("voice", "voiceSession", "speak", "voices")

        fun compatible(hub: JsonElement): Boolean {
            val features = hub["features"].array.orEmpty().mapNotNull { it.string }.toSet()
            return hub["protocol"].int == PROTOCOL_VERSION && features.containsAll(NEEDED_FEATURES)
        }

        /** "1:05" or "1:02:05". */
        fun elapsed(ms: Double): String {
            val s = maxOf(0, (ms / 1000).toInt())
            val h = s / 3600
            val m = (s % 3600) / 60
            val ss = "%02d".format(s % 60)
            return if (h > 0) "$h:${"%02d".format(m)}:$ss" else "$m:$ss"
        }

        private val UNAVAILABLE_PREFIX = Regex("^.*unavailable:\\s*")
        private val NO_SPEECH = Regex("unavailable|not set up|no speech|no recogni|api key|sign.?in", RegexOption.IGNORE_CASE)
        private val CANCEL_WORDS = Regex("^(no|nope|cancel|wait|hold on|don't|do not|abort)\\b")
        private val QUESTION_MARK = Regex("\\?\\s*$")
        private val REPORT_FAILED = Regex("SIGNIFICANT ACTION FAILED|(^|\n)ERROR:")
        private val AGREE = Regex("^(yes|yeah|sure|ok|okay)\\b")
        private val SWITCH = Regex("^(?:switch to|go to|open)\\s+(.+)$")
        private val QUIET_ERROR = Regex("no active response|cancel", RegexOption.IGNORE_CASE)
    }

    // region internal state (not observed)

    internal var deps: VoiceDeps? = deps
    private val core: VoiceCore? get() = deps?.core
    private var rtc: RealtimeTransport? = null
    private var basicIO: BasicAudio? = null
    private var closed = false
    /** Bumped by every start and stop: async work checks it after each suspension. */
    private var gen = 0
    private var redial: Job? = null
    private var graceSeq = 0
    private val timers = mutableListOf<VoiceTimer>()
    private var updatesJob: Job? = null
    // The world: every machine's sessions and open questions, keyed "machine/agent".
    private val infos = mutableMapOf<String, JsonElement>()
    private val prompts = mutableMapOf<String, List<JsonElement>>()
    private val statusOf = mutableMapOf<String, String?>()
    private val machineStates = mutableMapOf<String, ConnectionState>()
    private val wasOffline = mutableSetOf<String>()
    /** Machines whose hub lacks what native voice needs. */
    private val incompatible = mutableSetOf<String>()
    /** Audio-session ownership taken when voice mode activated it. */
    private var audioToken: Int? = null
    /** Where speech runs (`voiceSession`, `speak`, `voices`, `transcribe`, `distill`); kept across switches. */
    internal var speechMachine: String? = null
    // Conversation
    private var lastSpoken = ""
    private var more = mutableListOf<String>()
    private var optionPage = 0
    private var lastTick = 0L
    private val significant = mutableMapOf<String, String>()
    private data class Heard(val text: String, val at: Long, val echo: Boolean)
    private var recentHeard = listOf<Heard>()
    private var lastHeardEcho = false
    /** The undo window: [prompt] goes ahead at [until] (epoch ms) unless cancelled; [id] tells windows apart. */
    internal class Grace(val prompt: JsonElement, val until: Long, val timer: VoiceTimer, val id: Int)
    internal var grace: Grace? = null
        private set
    private var interrupted = false
    // Realtime
    private var saidLive = ""
    private var heardLive = ""
    private var active = false
    private var wantResponse = false
    private var userSpeaking = false
    private val calls = mutableSetOf<String>()
    private var serverTurns: JsonElement? = null
    private var clientVad: VoiceTimer? = null
    private var cvad: VoiceCore.Vad? = null
    private data class ClientTurn(val voiced: Double, val interrupted: Boolean)
    private var cturn: ClientTurn? = null
    private var overlap = false
    private var ducked = false
    private var shortTurn = false
    private var turnStart = 0.0
    // Basic voice
    private var vad: VoiceCore.Vad? = null
    private var capture: MutableList<FloatArray>? = null
    private var pre = mutableListOf<FloatArray>()
    private var rate = 48000.0
    private var manual = false
    private var voicedMs = 0.0
    private var pendingText = ""
    private var continueTimer: VoiceTimer? = null
    private var serverTts: Boolean? = null
    private var speakTurn = 0
    private var basicLevel = 0.0

    // endregion

    /** Everything one voice mode learned; a new voice mode starts fresh (the web makes a new VoiceMode). */
    private fun resetConversation() {
        grace?.timer?.cancel()
        grace = null
        recentHeard = emptyList()
        lastHeardEcho = false
        lastSpoken = ""
        more = mutableListOf()
        optionPage = 0
        significant.clear()
        saidLive = ""
        heardLive = ""
        active = false
        wantResponse = false
        userSpeaking = false
        calls.clear()
        serverTurns = null
        cturn = null
        overlap = false
        ducked = false
        shortTurn = false
        capture = null
        pre = mutableListOf()
        manual = false
        pendingText = ""
        serverTts = null
    }

    // region world

    private fun key(machine: String, agent: String) = "$machine/$agent"
    private val cur: String get() = key(machineId, agent)
    private val several: Boolean get() = (deps?.fleet?.machines?.size ?: 0) > 1
    private fun split(k: String): Pair<String, String> {
        val i = k.indexOf('/')
        return if (i < 0) k to "" else k.substring(0, i) to k.substring(i + 1)
    }
    private fun machineNameOf(id: String) = deps?.fleet?.machines?.firstOrNull { it.id == id }?.name ?: ""
    private fun agentName(k: String) = infos[k]["name"].string ?: "pi"
    /** "api on hetzner-box" when there are several machines. */
    private fun sessionLabel(k: String): String {
        val name = agentName(k)
        val m = machineNameOf(split(k).first)
        return if (several && m.isNotEmpty()) "$name on $m" else name
    }
    private fun reachable(k: String) = machineStates[split(k).first] != ConnectionState.OFFLINE
    private val openPrompt: JsonElement? get() = prompts[cur]?.firstOrNull()
    private val answering: Boolean get() = !prompts[cur].isNullOrEmpty()

    private suspend fun loadWorld() {
        val fleet = deps?.fleet ?: return
        // All machines at once; a machine that doesn't answer counts as offline.
        val replies = coroutineScope {
            fleet.machines.map { m -> m.id to async { catching { fleet.rpc(m.id, "hub", EmptyObject) }.getOrNull() } }
                .map { (id, reply) -> id to reply.await() }
        }
        for ((id, hub) in replies) took(id, hub)
        loadPrompts(cur)
        fleet.focus(machineId, agent)
    }

    /** One machine's `hub` reply: its sessions, and whether it can do voice at all. */
    private fun took(id: String, hub: JsonElement?) {
        val agents = hub["agents"].array
        if (hub == null || agents == null) {
            machineStates[id] = ConnectionState.OFFLINE
            return
        }
        if (compatible(hub)) incompatible.remove(id) else incompatible.add(id)
        for (a in agents) {
            val ag = a["agent"].string ?: continue
            infos[key(id, ag)] = a
            statusOf[key(id, ag)] = a["status"].string
        }
    }

    /**
     * The app's machine list changed while voice mode runs: new and re-paired machines are loaded,
     * removed ones vanish with their sessions; losing the followed session's machine ends voice mode.
     */
    fun machinesChanged(list: List<Machine>) {
        val fleet = deps?.fleet
        if (!isOpen || closed || fleet == null) return
        val before = fleet.machines.map { it.id }.toSet()
        val changed = fleet.setMachines(list)
        val after = list.map { it.id }.toSet()
        for (id in before - after) {
            for (k in infos.keys.toList()) if (split(k).first == id) {
                infos.remove(k)
                prompts.remove(k)
                statusOf.remove(k)
            }
            machineStates.remove(id)
            wasOffline.remove(id)
            incompatible.remove(id)
            if (speechMachine == id) speechMachine = null
        }
        render()
        if (machineId !in after) {
            setNote("That computer was removed from this phone.")
            return stop()
        }
        val g = gen
        for (id in changed) scope.launch {
            val hub = catching { fleet.rpc(id, "hub", EmptyObject) }.getOrNull()
            if (gen != g || closed) return@launch
            took(id, hub)
            render()
        }
    }

    private suspend fun loadPrompts(k: String) {
        val (m, a) = split(k)
        val fleet = deps?.fleet ?: return
        val snap = catching { fleet.agentCall(m, a, "snapshot", obj("limit" to 0)) }.getOrNull() ?: return
        snap["prompts"].array?.let { prompts[k] = it }
        snap["info"].let { info ->
            if (info is JsonObject) {
                infos[k] = info
                statusOf[k] = info["status"].string
            }
        }
        render()
    }

    /** Hub events and machine states for the life of voice mode. */
    private fun listen() {
        val fleet = deps?.fleet
        if (updatesJob != null || fleet == null) return
        updatesJob = scope.launch {
            fleet.updates().takeWhile { !closed }.collect { u ->
                when (u) {
                    is FleetUpdate.Event -> apply(u.machine, u.event)
                    is FleetUpdate.State -> machineState(u.machine, u.state)
                }
            }
        }
    }

    /** The app's state first (`handleEvent`), then voice mode's reaction (`onEvent`). */
    private fun apply(m: String, ev: HubEvent) {
        val a = ev.agent ?: return
        val k = key(m, a)
        var prevStatus: String? = null
        when (ev.type) {
            "info" -> {
                prevStatus = statusOf[k]
                ev.raw["info"]?.let { info ->
                    infos[k] = info
                    statusOf[k] = info["status"].string
                }
            }
            "gone" -> {
                infos.remove(k)
                prompts.remove(k)
            }
            "prompt" -> ev.raw["prompt"]?.let { p -> prompts[k] = prompts[k].orEmpty() + p }
            "prompt_end" -> prompts[k]?.let { list -> prompts[k] = list.filter { it["id"] != ev.raw["id"] } }
        }
        onEvent(k, ev, prevStatus)
        render()
    }

    /** A computer went away or came back; voice mode says so once if it's the one it follows. */
    private fun machineState(m: String, s: ConnectionState) {
        machineStates[m] = s
        val name = machineNameOf(m).ifEmpty { "The computer" }
        if (s == ConnectionState.OFFLINE && m !in wasOffline) {
            wasOffline.add(m)
            if (speechMachine == m) speechMachine = null // the next speech call picks another
            if (m == machineId) onMachine(name, back = false)
        } else if (s == ConnectionState.ONLINE && wasOffline.remove(m)) {
            if (m == machineId) onMachine(name, back = true)
        }
        render()
    }

    private fun onMachine(name: String, back: Boolean) {
        if (!back) earcon("failed")
        tell(
            if (back) "$name is back." else "$name went offline.",
            "[PI] The computer \"$name\" ${if (back) "is reachable again" else "went offline; its sessions can't be reached until it's back. Other sessions still work"}. Say only: \"$name ${if (back) "is back" else "went offline"}.\"",
        )
    }

    // endregion

    // region calls

    private suspend fun sessionCall(m: String, p: JsonElement = EmptyObject): JsonElement {
        val fleet = deps?.fleet
        if (fleet == null || closed) throw HubError.Network("Voice mode is not connected.")
        return fleet.agentCall(machineId, agent, m, p)
    }

    /**
     * Speech runs where the credentials are: the speech machine (the session's own first), then any
     * other online machine through one of its sessions. Only "can't do speech" moves on.
     */
    internal suspend fun speechCall(m: String, p: JsonElement): JsonElement {
        val fleet = deps?.fleet
        if (fleet == null || closed) throw HubError.Network("Voice mode is not connected.")
        val home = speechMachine ?: machineId
        val tries = mutableListOf<Pair<String, String>>()
        if (home == machineId) tries.add(machineId to agent) else agentOn(home)?.let { tries.add(home to it) }
        if (home != machineId && reachable(cur)) tries.add(machineId to agent)
        for (mm in fleet.machines) {
            if (mm.id == home || mm.id == machineId || machineStates[mm.id] == ConnectionState.OFFLINE || mm.id in incompatible) continue
            agentOn(mm.id)?.let { tries.add(mm.id to it) }
        }
        var last: Exception = HubError.Remote("no computer can do speech")
        for ((mid, a) in tries) {
            try {
                val r = fleet.agentCall(mid, a, m, p)
                speechMachine = mid
                return r
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                last = e
                if (closed) throw e
                // The speech machine can't be reached: forget it and re-pick from the next machine (once).
                if (e is HubError.Network && mid == home && tries.size > 1) {
                    if (speechMachine == mid) speechMachine = null
                    continue
                }
                if (!NO_SPEECH.containsMatchIn(e.text)) throw e
            }
        }
        throw last
    }

    private fun agentOn(m: String): String? = infos.keys.sorted().firstOrNull { split(it).first == m }?.let { split(it).second }

    private fun heartbeat(on: Boolean) {
        if (deps == null || agent.isEmpty()) return
        val mode = settings.attention.raw
        scope.launch { catching { sessionCall("voiceState", obj("on" to on, "mode" to mode)) } }
    }

    private fun loadPersonas() {
        scope.launch {
            val list = catching { speechCall("voices", EmptyObject) }.getOrNull()["personas"].array ?: return@launch
            settings = settings.copy(personas = list.mapNotNull { p ->
                val id = p["id"].string ?: return@mapNotNull null
                VoicePersona(
                    id = id,
                    name = p["name"].string ?: id,
                    blurb = p["blurb"].string ?: "",
                    rate = p["rate"].double ?: 1.0,
                    phonePrefer = (p["phone"]["prefer"].string ?: "").split("|").filter { it.isNotEmpty() },
                    phonePitch = p["phone"]["pitch"].double ?: 1.0,
                )
            })
        }
    }

    private val currentPersona: VoicePersona?
        get() = settings.personas.firstOrNull { it.id == settings.persona } ?: settings.personas.firstOrNull()

    // endregion

    // region lifecycle

    private suspend fun open() {
        val deps = deps ?: return
        render()
        deps.audioSession?.let { s ->
            try {
                s.activate()
            } catch (e: Exception) {
                setNote("${e.text} Tap the circle to try again.")
                return setState(VoiceState.PAUSED)
            }
            route = s.route
            audioToken = AudioOwner.claim()
            // Mute is scoped to a voice session (issue #3): a new session starts unmuted, even if a mute
            // (headset, system, an earlier session) was left on app-wide.
            if (s.isInputMuted) s.setInputMuted(false)
            muted = false
        }
        for ((k, v) in infos) statusOf[k] = v["status"].string
        heartbeat(true)
        timers.add(deps.scheduler.every(60.0) { heartbeat(true) })
        timers.add(deps.scheduler.every(1.0) { tick() })
        timers.add(deps.scheduler.every(0.1) { updateLevels() })
        var realtimeError = ""
        val g = gen
        try {
            startRealtime()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (g != gen || closed || engineKind != null) return
            realtimeError = e.text
            stopRealtime()
            startCascade()
        }
        if (closed || g != gen) return
        render()
        if (realtimeError.isNotEmpty()) basic(realtimeError)
        earcon("listen")
        uses += 1
        deps.prefs[USES_KEY] = uses.toString()
        if (deps.prefs[INTRO_KEY] == null) {
            deps.prefs[INTRO_KEY] = "1"
            tell(
                "I'm listening. Just talk to pi, and say stop any time.",
                "[PI] This is the developer's first time in voice mode. In one short sentence, say you're listening, they can just talk, and \"stop\" works any time.",
            )
        }
    }

    private suspend fun restart() {
        timers.forEach { it.cancel() }
        timers.clear()
        setNote("")
        setState(VoiceState.CONNECTING)
        open()
    }

    private fun wireAudioSession() {
        val s = deps?.audioSession ?: return
        s.onInterruption = { began -> interruption(began) }
        s.onRouteChange = { r -> route = r }
        s.onInputMute = { m -> if (m != muted) setMuted(m) }
        s.onNetworkChange = { networkChanged() }
        // Headset / lock-screen play-pause acts like tapping the circle (web: mediaSession play/pause).
        s.onRemoteToggle = {
            if (isOpen && !closed) tap() // push to talk: tap starts and ends the turn, as on the circle
        }
    }

    /** Interruptions (a call, the assistant): pause; resume when the system says so, else wait for a tap. */
    private fun interruption(began: Boolean?) {
        if (!isOpen || closed) return
        when (began) {
            true -> {
                interrupted = true
                // Nobody can say "stop" now: an undo window must not go ahead unheard (pi's question stays open).
                dropGrace()
                silence()
                rtc?.micEnabled = false
                clientTurns(false)
                setState(VoiceState.PAUSED)
            }
            false -> resumeAfterInterruption()
            null -> {
                interrupted = true
                dropGrace()
                setState(VoiceState.PAUSED)
            }
        }
    }

    private fun resumeAfterInterruption() {
        deps?.audioSession?.let { s ->
            try {
                s.activate()
                audioToken = AudioOwner.claim()
            } catch (e: Exception) {
                // Still interrupted (e.g. a call is on): stay paused; the next tap tries again.
                setNote("The microphone is busy. Tap to resume.")
                return setState(VoiceState.PAUSED)
            }
        }
        interrupted = false
        setNote("")
        rtc?.micEnabled = !muted && (settings.turns == VoiceTurns.OPEN || talking)
        val io = basicIO
        if (engineKind == VoiceEngineKind.BASIC && io != null) {
            // The interruption stopped the capture: start it again.
            io.stop()
            try {
                io.start(::onFrame)
            } catch (e: Exception) {
                setNote("${e.text} Tap the circle to try again.")
                interrupted = true
                return setState(VoiceState.PAUSED)
            }
        }
        setState(if (muted) VoiceState.PAUSED else listenState())
    }

    /**
     * The network changed: reopen the event streams and redial the call (no ICE restart through the
     * computer's endpoint) [verify on a device whether WebRTC alone recovers].
     */
    private fun networkChanged() {
        if (!isOpen || closed) return
        deps?.fleet?.reconnect()
        // One redial at a time: a burst of network changes while dialling is the same change.
        if (engineKind != VoiceEngineKind.REALTIME || redial != null) return
        val g = gen
        redial = scope.launch {
            try {
                stopRealtime()
                setState(VoiceState.CONNECTING)
                startRealtime()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Only this voice mode's own redial may fall back (not a newer call or a closed one).
                if (gen == g && !closed && engineKind == null) {
                    stopRealtime()
                    startCascade()
                    basic(e.text)
                }
            } finally {
                if (gen == g) redial = null
            }
        }
    }

    private fun updateLevels() {
        val r = rtc
        val b = basicIO
        var l = VoiceLevels()
        if (r != null) {
            l = VoiceLevels(mine = if (muted) 0.0 else r.micLevel, pi = r.piLevel)
        } else if (b != null) {
            var pi = 0.0
            if (state == VoiceState.SPEAKING) {
                pi = b.outLevel?.let { min(1.0, it) } ?: run {
                    // The phone's own synthesis can't be measured; a gentle speech-like motion instead.
                    val t = (deps?.ms?.invoke() ?: 0.0) / 1000
                    0.25 + 0.2 * abs(sin(t * 7.3) * sin(t * 2.9))
                }
            }
            l = VoiceLevels(mine = if (muted) 0.0 else min(1.0, basicLevel * 6), pi = pi)
        }
        _levels.value = l
    }

    // endregion

    // region UI state

    @JvmName("changeState") // the JVM name `setState` belongs to the property
    private fun setState(s: VoiceState) {
        state = s
        render()
    }

    private fun render() {
        now = deps?.now?.invoke() ?: System.currentTimeMillis()
        val info = infos[cur]
        sessionName = agentName(cur)
        machineName = machineNameOf(machineId).takeIf { several && it.isNotEmpty() }
        val (line, cls) = statusLineFor(cur)
        sessionLine = line
        sessionStatus = if (cls == "waiting") "waiting" else info["status"].string ?: "gone"
        sessions = infos.keys.filter(::reachable).sorted().map { k ->
            val (m, a) = split(k)
            VoiceSessionItem(
                agent = a, machine = m, name = agentName(k), machineName = if (several) machineNameOf(m) else null,
                status = statusOf[k] ?: "", waiting = prompts[k]?.size ?: 0,
            )
        }
        renderAsk()
    }

    /** The app header's status line (`statusLine(info)` in web/app.js): text and dot class. */
    private fun statusLineFor(k: String): Pair<String, String> {
        val info = infos[k] ?: return "" to ""
        prompts[k]?.firstOrNull()?.let { ask -> return "Needs you · ${ask["title"].string ?: ""}" to "waiting" }
        val st = info["status"].string
        if (st == "waiting") return "Needs you in the terminal" to "waiting"
        if (st == "working") {
            var t = "Working"
            info["since"].double?.let { since -> t += " · ${elapsed(now - since)}" }
            if (info["queued"].bool == true) t += " · message queued"
            return t to "working"
        }
        val bits = mutableListOf<String>()
        val task = info["task"].string
        if (!task.isNullOrEmpty()) bits.add(task) else {
            val cwd = info["cwd"].string ?: ""
            val parts = cwd.split("/").filter { it.isNotEmpty() }
            bits.add(if (parts.size > 2) "…/" + parts.takeLast(2).joinToString("/") else cwd)
        }
        info["context"]["percent"].double?.let { bits.add("${it.roundToInt()}% context") }
        info["cost"].double?.let { if (it > 0) bits.add("$" + String.format(Locale.US, "%.2f", it)) }
        return bits.filter { it.isNotEmpty() }.joinToString(" · ") to ""
    }

    @JvmName("changeNote")
    private fun setNote(text: String) {
        note = text
    }

    /** Realtime voice isn't available: say so once, briefly; the settings sheet keeps the reason. */
    private fun basic(error: String) {
        val reason = UNAVAILABLE_PREFIX.find(error)?.let { error.substring(it.range.last + 1) } ?: error
        settings = settings.copy(basicReason = reason)
        val msg = "Using basic voice. Details in voice settings."
        setNote(msg)
        deps?.scheduler?.after(8.0) { if (note == msg) setNote("") }
    }

    private fun heardCaption(text: String, live: Boolean = false) {
        heard = VoiceCaption(text, live)
    }

    private fun saidCaption(text: String, live: Boolean = false) {
        said = VoiceCaption(text, live)
    }

    /** pi's open question as a card (`renderAsk`). */
    private fun renderAsk() {
        val core = core
        val p = openPrompt
        val id = p["id"].string
        if (core == null || p == null || id == null) {
            question = null
            return
        }
        val kind = p["kind"].string ?: "input"
        val destructive = core.isDestructive(p)
        val options = mutableListOf<VoiceQuestion.Option>()
        if (kind == "confirm") {
            options.add(VoiceQuestion.Option(if (destructive) "Yes, do it" else "Yes", JsonPrimitive(true), destructive, primary = !destructive))
            options.add(VoiceQuestion.Option("No", JsonPrimitive(false), false))
        } else if (kind == "select") {
            for (o in p["options"].array.orEmpty().take(6).mapNotNull { it.string }) {
                options.add(VoiceQuestion.Option(o, JsonPrimitive(o), core.isDestructive(obj("title" to o))))
            }
            options.add(VoiceQuestion.Option("Cancel", null, false, ghost = true))
        }
        var title = p["title"].string ?: ""
        var g: VoiceQuestion.Grace? = null
        grace?.takeIf { it.prompt["id"].string == id }?.let { gr ->
            g = VoiceQuestion.Grace(gr.until, GRACE_MS / 1000)
            title = title.replace(QUESTION_MARK, "")
        }
        question = VoiceQuestion(id, kind, title, p["message"].string, destructive, options, g)
    }

    private fun earcon(name: String) = deps?.earcons?.play(name)

    // endregion

    // region turns and mute

    /** Push to talk: starts or ends your turn. */
    private fun toggleTalk() {
        if (engineKind == VoiceEngineKind.REALTIME) {
            val r = rtc ?: return
            talking = !talking
            r.micEnabled = talking
            if (talking && state == VoiceState.SPEAKING) hardInterrupt()
            if (!talking) {
                rt(obj("type" to "input_audio_buffer.commit"))
                shortTurn = false
                respond()
            }
            earcon(if (talking) "listen" else "heard")
            return setState(if (talking) VoiceState.HEARING else VoiceState.THINKING)
        }
        manualTurn()
    }

    @JvmName("changeMuted")
    private fun setMuted(m: Boolean) {
        muted = m
        if (m) {
            clientTurns(false)
            dropGrace() // a muted mic can't hear "stop"
        }
        deps?.audioSession?.setInputMuted(m)
        if (!m) setNote("")
        if (engineKind == VoiceEngineKind.REALTIME) rtc?.micEnabled = !m && (settings.turns == VoiceTurns.OPEN || talking)
        if (m) capture = null
        earcon(if (m) "off" else "listen")
        setState(if (m) VoiceState.PAUSED else listenState())
    }

    private fun setAttention(a: VoiceAttention) {
        if (a == settings.attention) return
        settings = settings.copy(attention = a)
        deps?.prefs?.set(MODE_KEY, a.raw)
        heartbeat(true)
        if (engineKind == VoiceEngineKind.REALTIME) {
            inject(
                if (a == VoiceAttention.GLANCE) "[PI] The developer can now glance at the screen. You may be a little more detailed; still no code read aloud."
                else "[PI] The developer cannot look at the screen any more (driving, running or similar). Keep it very short; defer anything visual.",
                respond = false,
            )
        }
        render()
    }

    private fun setTurns(t: VoiceTurns) {
        if (t == settings.turns) return
        settings = settings.copy(turns = t)
        talking = false
        if (t == VoiceTurns.TAP) clientTurns(false)
        deps?.prefs?.set(TURN_KEY, t.raw)
        if (engineKind == VoiceEngineKind.REALTIME) rtc?.micEnabled = !muted && t == VoiceTurns.OPEN
        setState(if (muted) VoiceState.PAUSED else listenState())
    }

    private fun listenState(): VoiceState = when {
        muted -> VoiceState.PAUSED
        settings.turns == VoiceTurns.TAP -> if (talking) VoiceState.HEARING else VoiceState.PAUSED
        else -> VoiceState.LISTENING
    }

    // endregion

    // region pi events

    private fun onEvent(k: String, ev: HubEvent, prev: String?) {
        val core = core
        if (closed || core == null) return
        when (ev.type) {
            "info" -> {
                if (k != cur) return
                val st = statusOf[k]
                if (st == "working" && prev != "working") workingSince = deps?.now?.invoke() ?: System.currentTimeMillis()
                if (st == "idle" && prev != null && prev != "idle") scope.launch { settled() }
                return
            }
            "prompt" -> {
                val p = ev.raw["prompt"] ?: return
                earcon("attention")
                if (k == cur) return ask(p)
                val name = sessionLabel(k)
                val title = p["title"].string ?: ""
                return tell(
                    "$name needs you: $title. Say \"switch to $name\" to answer it.",
                    "[PI] Another session, \"$name\", asks: $title. Tell the developer briefly; they can say \"switch to $name\".",
                )
            }
            "prompt_end" -> if (k == cur) {
                grace?.let { g -> if (g.prompt["id"] == ev.raw["id"]) dropGrace() }
                if (ev.raw["by"].string == "terminal" && engineKind == VoiceEngineKind.REALTIME) inject("[PI] That question was answered in the terminal.", respond = false)
                renderAsk()
                if (state == VoiceState.ASKING) setState(listenState())
                return
            }
            "gone" -> if (k == cur) tell("That session stopped.", "[PI] The session the developer was following stopped.")
        }
        // Tool calls are pi's business, except significant ones.
        val id = ev.raw["id"].string
        if (k != cur || id == null) return
        val title = ev.raw["title"].string
        if (ev.type == "tool_start" && title != null && core.isSignificant(title)) {
            significant[id] = title
            if (engineKind == VoiceEngineKind.REALTIME) inject("[PI] pi is running a significant action: $title", respond = false)
        }
        if (ev.type == "tool_end") {
            val ran = significant.remove(id)
            if (ran != null && ev.raw["isError"].bool == true) {
                earcon("failed")
                tell(
                    "Heads-up: a significant action pi ran just failed.",
                    "[PI] A significant action FAILED: $ran. Tell the developer in one sentence what kind of action failed (no command text); pi is still working.",
                )
            }
        }
    }

    private fun follow(machine: String, a: String) {
        val (oldMachine, oldAgent) = machineId to agent
        val fleet = deps?.fleet
        if (oldAgent.isNotEmpty() && fleet != null) {
            scope.launch { catching { fleet.agentCall(oldMachine, oldAgent, "voiceState", obj("on" to false)) } }
        }
        machineId = machine
        agent = a
        heartbeat(true)
        optionPage = 0
        render()
        if (engineKind == VoiceEngineKind.REALTIME) inject("[PI] Now following the session \"${agentName(cur)}\". ${statusLine()}", respond = false)
        val k = cur
        scope.launch {
            fleet?.focus(machine, a)
            loadPrompts(k)
        }
    }

    private fun statusLine(): String {
        val info = infos[cur] ?: return ""
        var s = "Status: ${info["status"].string ?: ""}."
        info["task"].string?.takeIf { it.isNotEmpty() }?.let { s += " Its task: $it." }
        info["last"].string?.takeIf { it.isNotEmpty() }?.let { s += " Its latest reply begins: $it" }
        return s
    }

    /** Soft working tick every few seconds while pi works and nobody talks: "still on it", eyes-free. */
    private fun tick() {
        now = deps?.now?.invoke() ?: System.currentTimeMillis()
        if (grace != null) renderAsk()
        sessionLine = statusLineFor(cur).first
        if (statusOf[cur] != "working") {
            if (state == VoiceState.WORKING) setState(listenState())
            return
        }
        if (state == VoiceState.LISTENING || (state == VoiceState.PAUSED && !muted && !interrupted)) setState(VoiceState.WORKING)
        if (state == VoiceState.WORKING && now - lastTick > 6000) {
            lastTick = now
            earcon("working")
        }
    }

    private suspend fun settled() {
        val g = gen
        val b = try {
            sessionCall("brief", obj("mode" to settings.attention.raw)).also { if (g != gen || closed) return }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (g != gen || closed) return
            return tell("pi finished, but I couldn't get the summary.", "[PI] pi finished but the summary failed: ${e.text}")
        }
        val report = b["report"].string ?: ""
        earcon(if (REPORT_FAILED.containsMatchIn(report)) "failed" else "done")
        more = b["more"].array.orEmpty().mapNotNull { it.string }.toMutableList()
        val speech = b["speech"].string ?: ""
        val offer = if (more.isNotEmpty() && engineKind == VoiceEngineKind.BASIC) " Want ${more[0]}?" else ""
        tell(
            speech + offer,
            "[PI] pi finished.\nSPOKEN BRIEF: $speech\n${if (more.isEmpty()) "" else "MORE AVAILABLE: ${more.joinToString("; ")} (offer at most one, briefly)\n"}REPORT (for follow-up questions, do not read out):\n$report",
        )
    }

    // endregion

    // region the undo window

    /** What the developer said lately (both engines), to check an earlier request really named an action. */
    private fun rememberHeard(text: String, echo: Boolean = false) {
        if (text.isEmpty()) return
        val t = clock()
        lastHeardEcho = echo
        recentHeard = (recentHeard.filter { t - it.at < 180_000 } + Heard(text, t, echo)).takeLast(12)
    }

    /** The claim that an earlier request named this action must hold for something actually heard. */
    internal fun namedEarlier(prompt: JsonElement, claimed: String? = null): Boolean {
        val core = core ?: return false
        if (!core.isDestructive(prompt)) return false
        // Only what was heard in the last 3 minutes (the web keeps no older request) counts.
        val t = clock()
        val heardTexts = recentHeard.filter { !it.echo && t - it.at < 180_000 }.map { it.text }
        return (claimed.isNullOrEmpty() || core.requestNames(prompt, claimed)) && heardTexts.any { core.requestNames(prompt, it) }
    }

    /** "Stop", "stop pi", "no", "wait"…: during an undo window they cancel the confirmation, not pi's work. */
    private fun cancelsGrace(text: String): Boolean {
        val core = core ?: return false
        val cmd = core.parseCommand(text)?.kind
        return cmd == "stopPi" || cmd == "quiet" || CANCEL_WORDS.containsMatchIn(core.norm(text))
    }

    /** You asked for this irreversible action by name: go ahead after a few seconds unless you say stop. */
    internal fun startGrace(prompt: JsonElement) {
        cancelGrace(quiet = true)
        val deps = deps ?: return
        graceSeq += 1
        val id = graceSeq
        // The timer answers only its own window, never a replacement.
        val timer = deps.scheduler.after(GRACE_MS / 1000) {
            val w = takeGrace(id) ?: return@after
            scope.launch { answerGrace(w, true) }
        }
        grace = Grace(prompt, deps.now() + GRACE_MS.toLong(), timer, id)
        earcon("attention")
        renderAsk()
    }

    /** Forgets the undo window without answering (answered elsewhere, voice mode ended, nobody listening). */
    private fun dropGrace() {
        grace?.timer?.cancel()
        grace = null
        renderAsk()
    }

    /** Detaches the current window synchronously (optionally only if it is window [id]). */
    private fun takeGrace(id: Int? = null): Grace? {
        val g = grace ?: return null
        if (id != null && g.id != id) return null
        g.timer.cancel()
        grace = null
        renderAsk()
        return g
    }

    private suspend fun answerGrace(g: Grace, value: Boolean) {
        val mine = gen
        try {
            sessionCall("answer", obj("id" to (g.prompt["id"] ?: JsonNull), "value" to value))
            if (mine != gen) return
            earcon(if (value) "heard" else "off")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine == gen) setNote(e.text)
        }
        renderAsk()
    }

    private suspend fun finishGrace(value: Boolean) {
        val g = takeGrace() ?: return
        answerGrace(g, value)
    }

    private fun cancelGrace(quiet: Boolean) {
        val g = takeGrace() ?: return
        val title = g.prompt["title"].string ?: ""
        scope.launch { answerGrace(g, false) }
        if (quiet) return
        silence()
        tell("Cancelled.", "[PI] The developer cancelled: $title. Say \"Cancelled\" and nothing else.")
    }

    private fun ask(prompt: JsonElement) {
        val core = core ?: return
        optionPage = 0
        renderAsk()
        val title = prompt["title"].string ?: ""
        // You just asked for exactly this by name: go ahead with an undo window instead of asking again.
        if (namedEarlier(prompt)) {
            startGrace(prompt)
            val what = title.replace(QUESTION_MARK, "")
            return tell(
                "$what: going ahead in a few seconds. Say stop to cancel.",
                "[PI] pi asks to confirm \"$title\". The developer already asked for exactly this, so the phone confirms it in ${(GRACE_MS / 1000).toInt()} seconds unless they say stop. Say only, in a few words: \"$what, say stop to cancel.\" Do not call answer_question.",
            )
        }
        val destructive = core.isDestructive(prompt)
        val opts = prompt["options"].array.orEmpty().mapNotNull { it.string }
        val optsText = if (opts.isEmpty()) "" else "\nOptions: " + opts.mapIndexed { i, o -> "${i + 1}. $o" }.joinToString("; ")
        val msg = prompt["message"].string?.let { " — $it" } ?: ""
        tell(
            core.speakPrompt(prompt),
            "[PI] QUESTION (id ${prompt["id"].string ?: ""}, ${prompt["kind"].string ?: ""}${if (destructive) ", DESTRUCTIVE: needs explicit confirmation naming the action" else ""}): $title$msg$optsText",
            VoiceState.ASKING,
        )
    }

    /** Speaks to the developer: realtime gets context to say it in its own voice; basic voice speaks [speech]. */
    private fun tell(speech: String, context: String, state: VoiceState? = null) {
        state?.let(::setState)
        if (engineKind == VoiceEngineKind.REALTIME) return inject(context, respond = true)
        if (engineKind == VoiceEngineKind.BASIC) speak(speech)
    }

    private fun interrupt() {
        if (engineKind == VoiceEngineKind.REALTIME) {
            if (active) rt(obj("type" to "response.cancel"))
            rt(obj("type" to "output_audio_buffer.clear"))
        } else silence()
        setState(listenState())
    }

    // endregion

    // region tools (realtime tool calls and basic voice's own intents)

    internal suspend fun tool(name: String, args: JsonElement): JsonElement {
        val core = core ?: return obj("error" to "no voice core")
        if (closed) return obj("error" to "voice mode ended")
        when (name) {
            "ask_pi" -> {
                val text = args["request"].string.orEmpty().trim()
                if (text.isEmpty()) return obj("error" to "empty request")
                val r = sessionCall("send", obj("text" to text, "mode" to if (args["when"].string == "after") "followUp" else "steer"))
                if (workingSince == null) workingSince = clock()
                val d = r["delivered"].string ?: ""
                val note = when (d) {
                    "prompt" -> "pi started working on it"
                    "steer" -> "pi is busy; the request steers its current work"
                    else -> "queued until pi finishes"
                }
                return obj("delivered" to d, "note" to note)
            }
            "answer_question" -> {
                val list = prompts[cur].orEmpty()
                val p = list.firstOrNull { args["id"] != null && it["id"] == args["id"] } ?: list.firstOrNull()
                    ?: return obj("error" to "pi is not waiting on a question")
                if (lastHeardEcho && core.isDestructive(p)) {
                    return obj("error" to "Not answered: the microphone picked up your own voice, not the developer. Ask them, naming the action.")
                }
                val ans = (args["answer"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content ?: ""
                val r = core.answerFor(p, ans)
                if (r.needConfirm != null && !r.answered && namedEarlier(p, args["earlier_request"].string)) {
                    startGrace(p)
                    return obj("pending" to "Confirming in ${(GRACE_MS / 1000).toInt()} seconds unless the developer says stop. Tell them in a few words that it is going ahead and that stop cancels.")
                }
                r.needConfirm?.let { w -> return obj("error" to "Not answered: this is an irreversible action. Ask the developer to confirm by saying \"yes, $w\".") }
                if (r.unclear) return obj("error" to "Not answered: the answer does not fit the question. Ask again briefly.")
                sessionCall("answer", answerParams(p, r.value))
                return obj("answered" to (r.value ?: "cancelled"))
            }
            "stop_pi" -> {
                sessionCall("abort")
                return obj("stopped" to true)
            }
            "pi_status" -> return sessionCall("voiceStatus")
            "pi_details" -> return sessionCall("details", obj("topic" to (args["topic"].string ?: ""), "mode" to settings.attention.raw))
            "switch_session" -> {
                val keys = infos.keys.filter(::reachable).sorted()
                val machineLabel = { k: String -> if (several) machineNameOf(split(k).first) else "" }
                val list = keys.map { k ->
                    val i = infos[k]
                    obj(
                        "agent" to k, "name" to (i["name"] ?: ""), "cwd" to (i["cwd"] ?: ""), "task" to (i["task"] ?: ""),
                        "status" to (i["status"] ?: ""), "machine" to machineLabel(k),
                    )
                }
                val brief = { k: String ->
                    val i = infos[k]
                    val o = mutableMapOf<String, Any?>("name" to (i["name"] ?: ""), "status" to (i["status"] ?: ""), "task" to i["task"], "waiting" to (prompts[k]?.size ?: 0))
                    if (machineLabel(k).isNotEmpty()) o["machine"] = machineLabel(k)
                    jsonOf(o)
                }
                val said = args["name"].string ?: ""
                val q = core.norm(said)
                if (q.isEmpty() || q == "list" || q == "sessions") return obj("sessions" to keys.map(brief))
                return when (val match = core.matchSession(list, q)) {
                    is VoiceCore.Match.Ambiguous -> obj("ambiguous" to match.indices.map { brief(keys[it]) }, "say" to "Ask which computer they mean.")
                    VoiceCore.Match.None -> obj(
                        "error" to "no session matches \"$said\"",
                        "sessions" to keys.map { k -> if (machineLabel(k).isEmpty()) agentName(k) else "${agentName(k)} on ${machineLabel(k)}" },
                    )
                    is VoiceCore.Match.One -> {
                        val k = keys[match.index]
                        val (m, a) = split(k)
                        follow(m, a)
                        obj("switched" to sessionLabel(k), "status" to (infos[k]["status"] ?: ""), "waiting" to (prompts[k]?.size ?: 0))
                    }
                }
            }
            "remain_silent" -> return obj("ok" to true)
            else -> return obj("error" to "unknown tool $name")
        }
    }

    /** `answer` params: the prompt's id, and the value unless it is a cancel. */
    private fun answerParams(p: JsonElement, value: JsonElement?): JsonElement =
        jsonOf(buildMap { put("id", p["id"] ?: JsonNull); value?.let { put("value", it) } })

    // endregion

    // region realtime engine

    private suspend fun startRealtime() {
        val deps = deps ?: return
        val r = deps.makeRealtime()
        rtc = r
        r.micEnabled = !muted && (settings.turns == VoiceTurns.OPEN || talking)
        r.onEvent = { ev -> if (rtc === r) onRealtime(ev) }
        r.onLost = { if (rtc === r && !closed && engineKind == VoiceEngineKind.REALTIME) realtimeLost() }
        active = false
        wantResponse = false
        userSpeaking = false
        calls.clear()
        val params = mutableMapOf<String, Any?>("mode" to settings.attention.raw)
        deps.prefs[PERSONA_KEY]?.let { params["persona"] = it }
        r.connect { sdp ->
            params["sdp"] = sdp
            val res = speechCall("voiceSession", jsonOf(params))
            res["sdp"].string ?: throw HubError.Remote("realtime unavailable: no answer")
        }
        if (rtc !== r || closed) throw HubError.Network("closed")
        engineKind = VoiceEngineKind.REALTIME
        inject("[PI] Voice mode started. The developer is following the session \"${agentName(cur)}\". ${statusLine()} Do not greet; wait for them to speak.", respond = false)
        setState(listenState())
        openPrompt?.let(::ask)
    }

    private fun realtimeLost() {
        stopRealtime()
        setNote("Realtime voice dropped; continuing with basic voice.")
        earcon("failed")
        startCascade()
    }

    private fun stopRealtime() {
        clientVad?.cancel()
        clientVad = null
        rtc?.onEvent = null
        rtc?.onLost = null
        rtc?.close()
        rtc = null
        if (engineKind == VoiceEngineKind.REALTIME) engineKind = null
    }

    private fun rt(ev: JsonElement) {
        rtc?.send(ev)
    }

    private fun inject(text: String, respond: Boolean) {
        rt(obj("type" to "conversation.item.create", "item" to obj("type" to "message", "role" to "user", "content" to listOf(obj("type" to "input_text", "text" to text)))))
        if (respond) respond()
    }

    /** response.create, deferred while a response is active or the developer is talking. */
    private fun respond() {
        if (active || userSpeaking) {
            wantResponse = true
            return
        }
        wantResponse = false
        active = true
        rt(obj("type" to "response.create"))
    }

    private fun turnDetection(value: JsonElement?) =
        obj("type" to "session.update", "session" to obj("type" to "realtime", "audio" to obj("input" to obj("turn_detection" to value))))

    /**
     * Turn-taking while pi speaks, done on the phone: server VAD off, pi ducks at your first sound,
     * stops after [BARGE_MS] of voiced speech; shorter sounds are committed and judged by transcript.
     */
    private fun clientTurns(wanted: Boolean) {
        val on = wanted && engineKind == VoiceEngineKind.REALTIME && settings.turns == VoiceTurns.OPEN && !muted
        if (on == (clientVad != null)) return
        if (on) {
            rt(turnDetection(null))
            cvad?.close()
            cvad = core?.vad(hangMs = 800.0, minSpeechMs = 120.0)
            cturn = null
            clientVad = deps?.scheduler?.every(0.02) { clientVadFrame() }
            return
        }
        clientVad?.cancel()
        clientVad = null
        cturn = null
        serverTurns?.let { rt(turnDetection(it)) }
    }

    /** One 20 ms frame of the client VAD. The level comes from WebRTC [verify against device AEC]. */
    private fun clientVadFrame() {
        val v = cvad ?: return
        val deps = deps ?: return
        val rms = rtc?.micRaw ?: 0.0
        val speaking = state == VoiceState.SPEAKING
        // Echo cancellation is good, not perfect: over pi's voice only clearly louder speech counts.
        v.setGain(if (speaking) 3.0 else 1.0)
        val e = v.feed(rms, deps.ms())
        if (e == "start") {
            cturn = ClientTurn(0.0, false)
            overlap = speaking
            if (speaking) duck()
        }
        val t0 = cturn
        if (t0 != null && rms > v.threshold()) {
            var t = t0.copy(voiced = t0.voiced + 20)
            if (!t.interrupted && t.voiced >= BARGE_MS) {
                t = t.copy(interrupted = true)
                cturn = t
                if (state == VoiceState.SPEAKING) hardInterrupt() else setState(VoiceState.HEARING)
            }
            cturn = t
        }
        val t = cturn
        if (e == "end" && t != null) {
            cturn = null
            if (t.interrupted || state != VoiceState.SPEAKING) {
                rt(obj("type" to "input_audio_buffer.commit"))
                shortTurn = !t.interrupted && t.voiced < 600
                setState(VoiceState.THINKING)
                if (!shortTurn) {
                    earcon("heard")
                    respond()
                }
                clientTurns(false)
            } else {
                // Short and over pi: commit it for its words while pi stays ducked; the transcript decides.
                rt(obj("type" to "input_audio_buffer.commit"))
                shortTurn = true
            }
        }
    }

    /** Lowers pi's voice while it finds out whether you are taking the turn. */
    private fun duck() {
        rtc?.remoteVolume = 0.2
        basicIO?.setDucked(true)
        ducked = true
    }

    private fun unduck() {
        if (!ducked) return
        ducked = false
        rtc?.remoteVolume = 1.0
        basicIO?.setDucked(false)
    }

    /** You took the turn: pi stops talking. */
    private fun hardInterrupt() {
        ducked = false
        if (engineKind == VoiceEngineKind.REALTIME) {
            // The response may be fully generated while its audio still plays: cancel only a live one.
            if (active) rt(obj("type" to "response.cancel"))
            rt(obj("type" to "output_audio_buffer.clear"))
            rtc?.remoteVolume = 1.0
        } else silence()
        setState(VoiceState.HEARING)
    }

    private fun onRealtime(ev: JsonElement) {
        val core = core ?: return
        val deps = deps ?: return
        when (ev["type"].string ?: "") {
            "session.updated" -> {
                val td = ev["session"]["audio"]["input"]["turn_detection"]
                if (td != null && td !is JsonNull && serverTurns == null) serverTurns = td
            }
            "input_audio_buffer.speech_started" -> {
                userSpeaking = true
                turnStart = deps.ms()
                overlap = false
                heardLive = ""
                heardCaption("", live = true)
                setState(VoiceState.HEARING)
            }
            "conversation.item.input_audio_transcription.delta" -> {
                heardLive += ev["delta"].string ?: ""
                heardCaption(heardLive, live = true)
            }
            "response.output_audio_transcript.delta" -> {
                val d = ev["delta"].string ?: ""
                // A second spoken part in the same response starts a new sentence.
                val last = saidLive.lastOrNull()
                val first = d.firstOrNull()
                if (last != null && last in ".!?" && first != null && !first.isWhitespace()) saidLive += " "
                saidLive += d
                saidCaption(saidLive, live = true)
            }
            "input_audio_buffer.speech_stopped" -> {
                userSpeaking = false
                val dur = deps.ms() - turnStart
                // A long turn is a turn: reply now. A short one waits for its words ("stop" or "mm-hmm"?).
                shortTurn = dur < SHORT_TURN_MS
                setState(VoiceState.THINKING)
                if (!shortTurn) {
                    earcon("heard")
                    respond()
                }
                if (wantResponse && !active) respond()
            }
            "conversation.item.input_audio_transcription.completed" -> {
                val text = ev["transcript"].string.orEmpty().trim()
                heardLive = ""
                heardCaption(text)
                val echo = overlap && core.isEcho(text, "$lastSpoken $saidLive")
                rememberHeard(text, echo)
                // "Stop" during an undo window cancels the confirmation, not pi's work.
                if (grace != null && !echo && cancelsGrace(text)) {
                    shortTurn = false
                    if (state == VoiceState.SPEAKING) hardInterrupt()
                    unduck()
                    cancelGrace()
                    return
                }
                if (shortTurn) {
                    shortTurn = false
                    // Listening noises, coughs and pi's own voice are not turns: pi carries on.
                    if (echo || core.isBackchannel(text, answering)) {
                        unduck()
                        if (state == VoiceState.THINKING || state == VoiceState.HEARING) setState(listenState())
                        return
                    }
                    if (state == VoiceState.SPEAKING) hardInterrupt()
                    earcon("heard")
                    respond()
                }
                val cmd = core.parseCommand(text)?.kind
                // Instant local "stop pi", before the model has even answered; its own stop_pi is then a no-op.
                // A bare "stop" is about the voice (voice-core.js "quiet"): interrupting the voice never stops pi.
                if (cmd == "stopPi" && statusOf[cur] == "working") scope.launch { catching { sessionCall("abort") } }
                if (cmd == "end") deps.scheduler.after(1.2) { stop() }
                if (!echo && cmd != null && cmd in core.settings) VoiceSetting.of(cmd)?.let(::applySetting)
            }
            "response.created" -> {
                active = true
                saidLive = ""
            }
            "output_audio_buffer.started" -> {
                setState(VoiceState.SPEAKING)
                clientTurns(true)
            }
            "output_audio_buffer.stopped", "output_audio_buffer.cleared" -> {
                if (state == VoiceState.SPEAKING) setState(if (answering) VoiceState.ASKING else listenState())
                if (cturn == null) clientTurns(false)
            }
            "response.output_audio_transcript.done" -> {
                lastSpoken = ev["transcript"].string ?: ""
                saidLive = ""
                saidCaption(lastSpoken)
            }
            "response.function_call_arguments.done" -> {
                // Handing a request to pi needs no words: the working sound says it.
                val name = ev["name"].string ?: ""
                if (name == "ask_pi") rt(obj("type" to "output_audio_buffer.clear"))
                scope.launch { runCall(ev["call_id"].string, name, ev["arguments"].string) }
            }
            "response.done" -> {
                active = false
                if (ev["response"]["status"].string == "failed") {
                    setNote("Voice: ${ev["response"]["status_details"]["error"]["message"].string ?: "response failed"}")
                }
                if (state == VoiceState.THINKING) setState(listenState())
                if (wantResponse) respond()
            }
            "error" -> {
                val msg = ev["error"]["message"].string ?: ""
                if (!QUIET_ERROR.containsMatchIn(msg)) setNote("Voice: ${msg.ifEmpty { "error" }}")
                if (msg.contains("active response", ignoreCase = true)) wantResponse = true
            }
        }
    }

    private suspend fun runCall(callId: String?, name: String, rawArgs: String?) {
        if (callId == null || callId in calls) return
        calls.add(callId)
        val args = catching { parseJson(rawArgs ?: "{}") }.getOrNull() ?: EmptyObject
        val g = gen
        val out = try {
            tool(name, args)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            obj("error" to e.text)
        }
        if (g != gen || closed) return
        rt(obj("type" to "conversation.item.create", "item" to obj("type" to "function_call_output", "call_id" to callId, "output" to out.encode())))
        if (name == "ask_pi" && out["error"] == null) {
            // Delegated: say nothing more unless it was queued; the working tick tells them pi is on it.
            if (out["delivered"].string != "prompt") respond() else setState(VoiceState.WORKING)
            return
        }
        if (name != "remain_silent") respond()
    }

    // endregion

    // region basic voice (cascade): VAD on the phone, recognition on the computer, speech here

    private fun startCascade() {
        val deps = deps ?: return
        engineKind = VoiceEngineKind.BASIC
        val io = basicIO ?: deps.makeBasic()
        basicIO = io
        vad?.close()
        vad = core?.vad(hangMs = if (settings.attention == VoiceAttention.EYES_BUSY) 1100.0 else 900.0)
        pre = mutableListOf()
        capture = null
        pendingText = ""
        try {
            io.start(::onFrame)
        } catch (e: Exception) {
            setNote("${e.text} Tap the circle to try again.")
        }
        setState(listenState())
        openPrompt?.let(::ask)
    }

    private fun stopCascade() {
        basicIO?.stop()
        if (engineKind == VoiceEngineKind.BASIC) engineKind = null
    }

    private fun onFrame(frame: FloatArray, sampleRate: Double) {
        val deps = deps ?: return
        val vad = vad ?: return
        if (closed) return
        rate = sampleRate
        var sum = 0f
        for (x in frame) sum += x * x
        val rms = if (frame.isEmpty()) 0.0 else sqrt(sum / frame.size).toDouble()
        basicLevel = rms
        val capturing = capture
        if (capturing != null) capturing.add(frame) else {
            pre.add(frame)
            if (pre.size > 6) pre.removeAt(0)
        }
        if (manual) return
        if (settings.turns == VoiceTurns.TAP || state == VoiceState.THINKING || state == VoiceState.PAUSED || muted) return
        // While our own voice plays, only clearly louder speech counts (echo cancellation is not perfect).
        vad.setGain(if (state == VoiceState.SPEAKING) 4.0 else 1.0)
        val ev = vad.feed(rms, deps.ms())
        // While ducked: count voiced time, not elapsed time.
        if (ducked && rms > vad.threshold()) {
            voicedMs += frame.size / rate * 1000
            if (voicedMs >= BARGE_MS) hardInterrupt()
        }
        if (ev == "start") {
            // Soft barge-in, as in realtime: duck now, stop only if the speech goes on.
            overlap = state == VoiceState.SPEAKING
            if (overlap) {
                duck()
                voicedMs = 0.0
            }
            continueTimer?.cancel()
            if (capture == null) capture = pre.toMutableList()
            setState(VoiceState.HEARING)
        } else if (ev == "end" && capture != null) {
            scope.launch { endTurn() }
        }
    }

    private fun manualTurn() {
        if (!manual) {
            silence()
            manual = true
            talking = true
            capture = pre.toMutableList()
            earcon("listen")
            return setState(VoiceState.HEARING)
        }
        manual = false
        talking = false
        scope.launch { endTurn() }
    }

    private suspend fun endTurn() {
        val core = core ?: return
        val frames = capture.orEmpty()
        capture = null
        val all = FloatArray(frames.sumOf { it.size })
        var at = 0
        for (f in frames) {
            f.copyInto(all, at)
            at += f.size
        }
        if (all.size < rate * 0.35) {
            if (ducked) {
                unduck()
                return setState(VoiceState.SPEAKING)
            }
            return setState(listenState())
        }
        earcon("heard")
        setState(VoiceState.THINKING)
        val audio = BasicVoice.wav(BasicVoice.downsample(all, rate), 16000)
        val g = gen
        var text = try {
            val r = speechCall("transcribe", obj("audio" to Base64.getEncoder().encodeToString(audio), "mime" to "audio/wav", "distill" to false))
            if (g != gen || closed) return
            r["raw"].string.orEmpty().trim()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (g != gen || closed) return
            setNote("Recognition failed: ${e.text}")
            earcon("failed")
            return setState(listenState())
        }
        if (text.isEmpty()) return setState(listenState())
        text = "$pendingText $text".trim()
        // Over pi's voice: a listening noise, a cough or pi's own echo is not a turn; pi carries on.
        if (ducked) {
            if (core.isEcho(text, lastSpoken) || core.isBackchannel(text, answering)) {
                unduck()
                return setState(VoiceState.SPEAKING)
            }
            hardInterrupt()
        }
        heardCaption(text)
        // Trailing "and…" / "um": wait a moment for the rest of the thought.
        if (core.incomplete(text) && !manual && settings.turns == VoiceTurns.OPEN) {
            pendingText = text
            setState(VoiceState.LISTENING)
            continueTimer = deps?.scheduler?.after(2.2) {
                val t = pendingText
                pendingText = ""
                if (t.isNotEmpty()) scope.launch { handleUtterance(t) }
            }
            return
        }
        pendingText = ""
        handleUtterance(text)
    }

    /** Basic voice's own conversation logic: commands, answers to dialogs, then requests to pi. */
    internal suspend fun handleUtterance(text: String) {
        val core = core ?: return
        if (closed) return
        val g = gen
        rememberHeard(text)
        try {
            val cmd = core.parseCommand(text)?.kind
            if (grace != null && cancelsGrace(text)) return cancelGrace()
            if (cmd == "end") return stop()
            if (cmd == "help") return speak(core.help)
            // "Stop" stops the voice (quiet, below); only "stop pi" / "cancel that" stops pi's work.
            if (cmd == "stopPi") {
                tool("stop_pi", EmptyObject)
                alive(g)
                return speak("Stopped pi.")
            }
            if (cmd == "quiet") return setState(listenState())
            if (cmd == "repeat") return speak(lastSpoken.ifEmpty { "I haven't said anything yet." })
            if (cmd == "status") {
                val s = tool("pi_status", EmptyObject)["speech"].string ?: ""
                alive(g)
                return speak(s)
            }
            val setting = VoiceSetting.of(cmd)
            if (cmd != null && cmd in core.settings && setting != null) {
                applySetting(setting)
                return speak(
                    when (setting) {
                        VoiceSetting.PUSH_TO_TALK -> "Push to talk. Hold the circle while you talk."
                        VoiceSetting.OPEN_MIC -> "Open mic."
                        else -> "Okay."
                    },
                )
            }
            if (cmd == "shorter") {
                settings = settings.copy(attention = VoiceAttention.EYES_BUSY)
                render()
                return speak("Okay, shorter.")
            }
            val n = core.norm(text)
            openPrompt?.let { p ->
                if ("more options" in n && p["kind"].string == "select") {
                    optionPage += 1
                    return speak(core.speakPrompt(p, optionPage))
                }
                val r = core.answerFor(p, text)
                r.needConfirm?.let { w -> return speak("To be safe: say \"yes, $w\" to go ahead, or no.") }
                if (!r.unclear) {
                    sessionCall("answer", answerParams(p, r.value))
                    alive(g)
                    return speak(
                        when (r.value) {
                            JsonPrimitive(false) -> "Okay, no."
                            null -> "Cancelled."
                            else -> "Okay."
                        },
                    )
                }
                if (p["kind"].string != "input" && text.split(" ").filter { it.isNotEmpty() }.size < 4) {
                    return speak("Sorry. ${core.speakPrompt(p, optionPage)}")
                }
            }
            if ((cmd == "more" || AGREE.containsMatchIn(n)) && more.isNotEmpty()) {
                val topic = more.removeAt(0)
                val s = tool("pi_details", obj("topic" to topic))["speech"].string ?: ""
                alive(g)
                return speak(s)
            }
            if (cmd == "more") return speak("That's all I have.")
            SWITCH.find(n)?.let { m ->
                val name = m.groupValues[1]
                val r = tool("switch_session", obj("name" to name))
                alive(g)
                r["ambiguous"].array?.let { amb -> return speak("On which computer? ${amb.mapNotNull { it["machine"].string }.joinToString(", or ")}.") }
                if (r["error"] != null) return speak("I can't find $name.")
                val waiting = if ((r["waiting"].double ?: 0.0) > 0) ". It has a question for you" else ""
                return speak("Now on ${r["switched"].string ?: name}$waiting.")
            }
            // A request for pi: distil it into what was meant, then send.
            var request = text
            catching { sessionCall("distill", obj("raw" to text)) }.getOrNull()?.let { d ->
                val t = d["text"].string
                if (!t.isNullOrEmpty()) request = d["editor"].string ?: t
            }
            // Voice mode may have ended while distilling: never send a request after End.
            alive(g)
            val r = tool("ask_pi", obj("request" to request))
            alive(g)
            r["error"].string?.let { e -> return speak("I couldn't send that: $e") }
            more = mutableListOf()
            if (r["delivered"].string == "prompt") return setState(VoiceState.WORKING)
            return speak(if (r["delivered"].string == "steer") "Passed on." else "Queued for after this.")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (g != gen || closed) return
            earcon("failed")
            speak("Something went wrong: ${e.text}")
        }
    }

    private class Stale : Exception()

    /** Throws when voice mode ended (or restarted) since generation [g]. */
    private fun alive(g: Int) {
        if (g != gen || closed) throw Stale()
    }

    /** Stops whatever is speaking: the computer's audio or the phone's synthesis. */
    private fun silence() {
        basicIO?.silence()
    }

    /** Speaks with the computer's voice when it has one, else the phone's. */
    private fun speak(text: String) {
        val core = core ?: return
        val parts = core.chunks(text)
        if (parts.isEmpty()) return setState(listenState())
        lastSpoken = text
        saidCaption(text)
        silence()
        speakTurn += 1
        val turn = speakTurn
        val afterSpeech = {
            if (state == VoiceState.SPEAKING) setState(if (answering) VoiceState.ASKING else listenState())
        }
        scope.launch {
            if (serverTts != false) {
                try {
                    val p = mutableMapOf<String, Any?>("text" to text)
                    deps?.prefs?.get(PERSONA_KEY)?.let { p["persona"] = it }
                    val r = speechCall("speak", jsonOf(p))
                    if (turn != speakTurn || closed) return@launch
                    val data = r["audio"].string?.let { catching { Base64.getDecoder().decode(it) }.getOrNull() }
                    val io = basicIO
                    if (data != null && io != null) {
                        io.play(data, r["mime"].string ?: "audio/mpeg") { afterSpeech() }
                        setState(VoiceState.SPEAKING)
                        return@launch
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (turn != speakTurn) return@launch
                    // Not configured: stop asking. Other failures: this time only.
                    if (e.text.contains("tts unavailable")) serverTts = false
                }
            }
            if (turn != speakTurn || closed) return@launch
            speakLocal(parts, afterSpeech)
        }
    }

    private fun speakLocal(parts: List<String>, done: () -> Unit) {
        val persona = currentPersona
        setState(VoiceState.SPEAKING)
        basicIO?.speakLocal(parts, persona, (if (settings.attention == VoiceAttention.EYES_BUSY) 1.05 else 1.0) * (persona?.rate ?: 1.0), done)
    }

    // endregion

    private fun clock(): Long = deps?.now?.invoke() ?: System.currentTimeMillis()
}

/** The sentence a UI shows for an error (HubError messages are already sentences). */
internal val Throwable.text: String get() = message ?: toString()

/** `try?`: the result, or the failure; coroutine cancellation still propagates. */
internal inline fun <T> catching(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Result.failure(e)
}
