package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.EmptyObject
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.HubEvent
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.jsonOf
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.json.JsonElement
import java.io.File
import kotlin.math.roundToLong

// Port of native/ios/PiTests/Voice/VoiceFakes.swift.

/** web/voice-core.js from this checkout: the file the `bundleVoiceCore` task puts in the app. */
fun repoVoiceCore(): VoiceCore =
    VoiceCore(File(System.getProperty("pi.repo"), "web/voice-core.js").readText(), "repo")

/** setTimeout/setInterval on a manual clock. */
class ManualScheduler : VoiceScheduler {
    private class Item(val id: Int, var at: Double, val every: Double?, val f: () -> Unit)
    private val items = mutableListOf<Item>()
    private var nextId = 0
    var t = 0.0
        private set
    val base = 1_800_000_000_000L
    val now: Long get() = base + (t * 1000).roundToLong()

    override fun after(seconds: Double, f: () -> Unit) = add(seconds, null, f)
    override fun every(seconds: Double, f: () -> Unit) = add(seconds, seconds, f)

    private fun add(s: Double, every: Double?, f: () -> Unit): VoiceTimer {
        val id = ++nextId
        items.add(Item(id, t + s, every, f))
        return VoiceTimer { items.removeAll { it.id == id } }
    }

    /** Runs every timer due within [seconds], in time order. */
    fun advance(seconds: Double) {
        val end = t + seconds
        while (true) {
            val item = items.filter { it.at <= end + 1e-9 }.minByOrNull { it.at } ?: break
            t = maxOf(t, item.at)
            if (item.every != null) item.at += item.every else items.remove(item)
            item.f()
        }
        t = end
    }
}

class FakeRealtime : RealtimeTransport {
    override var onEvent: ((JsonElement) -> Unit)? = null
    override var onLost: (() -> Unit)? = null
    override var micEnabled = true
    override var remoteVolume = 1.0
    override var micLevel = 0.0
    override var piLevel = 0.0
    override var micRaw = 0.0
    val sent = mutableListOf<JsonElement>()
    var closed = false
        private set
    var offerSdp = "v=0 offer"

    override suspend fun connect(exchange: suspend (String) -> String) {
        exchange(offerSdp)
    }
    override fun send(event: JsonElement) {
        sent.add(event)
    }
    override fun close() {
        closed = true
    }

    /** The server sends an event. */
    fun emit(e: JsonElement) = onEvent?.invoke(e)
    val types: List<String> get() = sent.mapNotNull { it["type"].string }
    /** Texts of injected `[PI]` context messages. */
    val injected: List<String>
        get() = sent.filter { it["type"].string == "conversation.item.create" && it["item"]["type"].string == "message" }
            .mapNotNull { it["item"]["content"][0]["text"].string }
    fun clear() = sent.clear()
}

class FakeBasic : BasicAudio {
    var started = false
    val spoken = mutableListOf<String>()
    var duckedNow = false
    override var isSpeaking = false
    override val outLevel: Double? get() = null
    override fun start(onFrame: (FloatArray, Double) -> Unit) {
        started = true
    }
    override fun stop() {
        started = false
    }
    override fun play(audio: ByteArray, mime: String, done: () -> Unit) {}
    override fun speakLocal(parts: List<String>, persona: VoicePersona?, rate: Double, done: () -> Unit) {
        spoken.add(parts.joinToString(" "))
    }
    override fun silence() {}
    override fun setDucked(ducked: Boolean) {
        duckedNow = ducked
    }
}

class FakeEarcons : EarconPlaying {
    val played = mutableListOf<String>()
    var stopped = 0
    override fun play(name: String) {
        played.add(name)
    }
    override fun stop() {
        stopped += 1
    }
}

class FakeAudioSession : VoiceAudioSession {
    override var route = "Speaker"
    override var onInterruption: ((Boolean?) -> Unit)? = null
    override var onRouteChange: ((String) -> Unit)? = null
    override var onInputMute: ((Boolean) -> Unit)? = null
    override var onNetworkChange: (() -> Unit)? = null
    override var onRemoteToggle: (() -> Unit)? = null
    /** The system input mute (what [isInputMuted] reports). */
    var systemMuted = false
    override val isInputMuted get() = systemMuted
    var activeNow = false
    var failActivate = false
    var activations = 0
    var deactivations = 0
    override fun activate() {
        activations += 1
        if (failActivate) throw HubError.Network("Session activation failed.")
        activeNow = true
    }
    override fun deactivate() {
        deactivations += 1
        activeNow = false
    }
    override fun setInputMuted(muted: Boolean) {
        systemMuted = muted
    }
}

class MemoryPrefs : VoicePrefs {
    private val values = mutableMapOf<String, String>()
    override fun get(key: String): String? = values[key]
    override fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

/** Machines, sessions and RPCs; records every call. */
class FakeHub(override var machines: List<FleetMachine>) : VoiceFleet {
    data class Call(val machine: String, val agent: String?, val m: String, val p: JsonElement)
    val agents = mutableMapOf<String, List<JsonElement>>()
    val calls = mutableListOf<Call>()
    /** Per-method replies; throw to fail. */
    var reply: (Call) -> JsonElement = { EmptyObject }
    /** Methods whose replies wait for [release]. */
    var hold = mutableSetOf<String>()
    private val held = mutableMapOf<String, MutableList<CompletableDeferred<Unit>>>()
    /** Per-machine hub features (default: everything voice needs). */
    val features = mutableMapOf<String, List<String>>()
    private var channel: Channel<FleetUpdate>? = null

    fun release(m: String) {
        hold.remove(m)
        held.remove(m)?.forEach { it.complete(Unit) }
    }

    private suspend fun wait(m: String) {
        if (m !in hold) return
        CompletableDeferred<Unit>().also { held.getOrPut(m) { mutableListOf() }.add(it) }.await()
    }

    override suspend fun rpc(machine: String, m: String, p: JsonElement): JsonElement {
        if (m == "hub") {
            return obj("agents" to agents[machine].orEmpty(), "protocol" to 1, "features" to (features[machine] ?: VoiceEngine.NEEDED_FEATURES))
        }
        val c = Call(machine, null, m, p)
        calls.add(c)
        return reply(c)
    }

    override suspend fun agentCall(machine: String, agent: String, m: String, p: JsonElement): JsonElement {
        val c = Call(machine, agent, m, p)
        calls.add(c)
        if (m == "snapshot") return obj("prompts" to emptyList<Any>())
        wait(m)
        return reply(c)
    }

    override suspend fun focus(machine: String, agent: String) {}
    override fun updates(): Flow<FleetUpdate> = Channel<FleetUpdate>(Channel.UNLIMITED).also { channel = it }.receiveAsFlow()
    override fun reconnect() {}
    override fun setMachines(list: List<Machine>): Set<String> {
        val before = machines.map { it.id }.toSet()
        machines = list.map { FleetMachine(it.id, it.name) }
        return list.map { it.id }.toSet() - before
    }

    fun emit(u: FleetUpdate) {
        channel?.trySend(u)
    }
    fun event(machine: String, raw: JsonElement) = emit(FleetUpdate.Event(machine, HubEvent(raw)))
    fun state(machine: String, s: ConnectionState) = emit(FleetUpdate.State(machine, s))
    fun calls(m: String) = calls.filter { it.m == m }
}

/** `["id": "p1", "value": true]` in tests. */
fun json(vararg pairs: Pair<String, Any?>): JsonElement = jsonOf(mapOf(*pairs))
