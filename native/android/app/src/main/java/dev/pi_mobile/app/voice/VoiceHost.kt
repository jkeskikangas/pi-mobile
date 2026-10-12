package dev.pi_mobile.app.voice

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.KeystoreMachineStore
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.MachineStore
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Owns the app's one voice engine and starts it for every entry point: the bridge's `voice.start`
 * (BRIDGE.md), the Quick Settings tile, the launcher shortcut and "Answer by voice". Idempotent (an open
 * voice mode just follows the new session), drains dictation first, gates on consent and the microphone
 * permission, and keeps the voice service running while voice mode is open.
 * Port of native/ios/Pi/Voice/VoiceHost.swift with the session pick of Intents/VoiceActivityController.swift.
 *
 * Everything runs on [scope] (the main dispatcher in the app).
 */
class VoiceHost(
    private val scope: CoroutineScope,
    private val prefs: Prefs,
    /** The paired machines now (the app's machine list). */
    private val machines: () -> List<Machine>,
    /** One sealed connection per machine (the app passes [HubFleetClient] over its HubClient). */
    private val connect: (Machine) -> FleetClient,
    private val platform: Platform,
    /** The AI consent gate: returns when voice may be sent, else throws with a sentence (ConsentController.ensure). */
    private val consent: suspend (kind: String) -> Unit,
    /** Stops a dictation take that is recording or starting, so voice mode gets the microphone. */
    private val drainDictation: suspend () -> Unit,
    /** A computer confirmed this phone was removed: forget it (the app's verified-removal path). */
    private val forget: (Machine) -> Unit,
    private val scheduler: VoiceScheduler = CoroutineScheduler(scope),
) {
    /** The device parts voice mode runs on; tests pass fakes. */
    interface Platform {
        /** The bundled voice-core.js; throws when it can't load. */
        fun core(): VoiceCore
        val micAllowed: Boolean
        fun realtime(): RealtimeTransport
        fun basic(): BasicAudio
        fun earcons(core: VoiceCore): EarconPlaying
        fun audioSession(): VoiceAudioSession?
        /** Keeps voice mode alive in the background ([VoiceService]). */
        fun startService()
    }

    /** A session voice mode can follow. */
    data class Target(val agent: String, val machine: String, val name: String = "", val machineName: String? = null)

    val engine = VoiceEngine(scope)

    /** The engine while voice mode is open, else null: the UI shows the voice screen for it. */
    val running: StateFlow<VoiceEngine?> = engine.ui.map { if (it.isOpen) engine else null }
        .stateIn(scope, SharingStarted.Eagerly, null)

    /** Voice mode closed: the web shell calls `window.PiNative.voiceClosed()` (BRIDGE.md). */
    var onClosed: (() -> Unit)? = null

    private var core: VoiceCore? = null

    init {
        // The session last talked to: "Talk to pi" picks it when nothing needs you.
        scope.launch {
            engine.ui.filter { it.isOpen && it.agent.isNotEmpty() }
                .map { Prefs.Focus(it.agent, it.machineId, it.sessionName) }
                .distinctUntilChanged()
                .collect { prefs.lastFocus = it }
        }
    }

    /**
     * Starts voice mode on [agent] on [machine], or (no agent) on the session that needs you, else the one used
     * last. Throws [HubError] with a sentence to show when it can't.
     */
    suspend fun start(agent: String? = null, machine: String? = null) {
        drainDictation()
        val target = if (agent != null && machine != null) Target(agent, machine) else pickSession(agent) ?: throw HubError.Network(NO_SESSION)
        val open = engine.isOpen
        if (!open && machines().none { it.id == target.machine }) throw HubError.Network(NOT_PAIRED)
        // Every entry point and every switch passes here: no audio leaves before the current OK.
        consent("voice")
        if (open) return engine.start(target.agent, target.machine)
        if (!platform.micAllowed) throw HubError.Network(MIC_OFF)
        val core = core ?: try {
            platform.core().also { core = it }
        } catch (_: Exception) {
            throw HubError.Network("Voice mode couldn't load.")
        }
        val fleet = LiveFleet(machines(), scope, connect)
        // 401 from a computer: forget it only once a fresh `hub` call confirms the removal.
        fleet.onUnauthorized = { id -> scope.launch { machineRejected(id) } }
        engine.attach(
            VoiceDeps(
                fleet = fleet, core = core,
                makeRealtime = platform::realtime, makeBasic = platform::basic,
                earcons = platform.earcons(core), audioSession = platform.audioSession(),
                prefs = PrefsVoicePrefs(prefs), scheduler = scheduler,
            ),
        )
        engine.onClose = { onClosed?.invoke() }
        platform.startService()
        // The voice screen shows as soon as the engine opens; connecting continues behind it.
        scope.launch { engine.start(target.agent, target.machine) }
    }

    /** End voice mode (the notification's End, the voice screen). */
    fun end() = engine.stop()

    /** The app's machine list changed: a running voice mode follows it (added, removed, re-paired). */
    fun machinesChanged(list: List<Machine>) {
        if (engine.isOpen) engine.machinesChanged(list)
    }

    /** Forget a machine only if a fresh `hub` call says this phone was removed there, and only the credential checked. */
    private suspend fun machineRejected(id: String) {
        val m = machines().firstOrNull { it.id == id } ?: return
        try {
            connect(m).hub()
        } catch (_: HubError.Unauthorized) {
            forget(m)
        } catch (_: Exception) {
        }
    }

    /** Every reachable session with its urgency, then [pick]; [agent] narrows it to that session. */
    private suspend fun pickSession(agent: String?): Target? {
        val list = machines()
        val several = list.size > 1
        val all = coroutineScope {
            list.map { m ->
                async {
                    val info = catching { connect(m).hub() }.getOrNull() ?: return@async emptyList()
                    info.agents.mapNotNull { a ->
                        val id = a["agent"].string ?: return@mapNotNull null
                        Target(id, m.id, a["name"].string ?: "", if (several) m.name else null) to urgency(a["status"].string)
                    }
                }
            }.awaitAll().flatten()
        }
        return pick(all.filter { agent == null || it.first.agent == agent }, prefs.lastFocus)
    }

    companion object {
        const val NO_SESSION = "No pi session is reachable. Run /remote on your computer."
        const val NOT_PAIRED = "That computer isn't paired with this phone."
        const val MIC_OFF = "Microphone access is off. Turn it on in Settings."
        /** The extra that opens the app straight into voice mode (tile, shortcut, notification tap). */
        const val EXTRA_VOICE = "voice"

        @Volatile var sharedOrNull: VoiceHost? = null
            private set
        val shared: VoiceHost get() = sharedOrNull ?: error("VoiceHost.install was not called")

        /**
         * The app's host, from Application.onCreate: real audio, WebRTC and the voice service. The caller
         * passes the consent gate, the dictation drain and the verified removal; machines come from [store].
         */
        fun install(
            context: Context,
            consent: suspend (kind: String) -> Unit,
            drainDictation: suspend () -> Unit,
            forget: (Machine) -> Unit,
            store: MachineStore = KeystoreMachineStore(context),
            prefs: Prefs = Prefs(context),
            connect: (Machine) -> FleetClient = { HubFleetClient(HubClient(it)) },
        ): VoiceHost {
            val app = context.applicationContext
            val scope = MainScope()
            return VoiceHost(scope, prefs, store::load, connect, AndroidPlatform(app, scope), consent, drainDictation, forget)
                .also { sharedOrNull = it }
        }

        /** Opens the app on the voice screen. */
        fun openIntent(context: Context): Intent =
            (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent())
                .putExtra(EXTRA_VOICE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        /** True while one of the app's screens is in front (a microphone service may start now). */
        fun appVisible(): Boolean =
            ActivityManager.RunningAppProcessInfo().also(ActivityManager::getMyMemoryState).importance <=
                ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND

        fun urgency(status: String?): Int = when (status) {
            "waiting" -> 0
            "working" -> 1
            else -> 2
        }

        /** Pure choice, unit tested: needs-you beats last-used beats the rest (stable order). */
        fun pick(all: List<Pair<Target, Int>>, saved: Prefs.Focus?): Target? {
            all.firstOrNull { it.second == 0 }?.let { return it.first }
            if (saved != null) all.firstOrNull { it.first.agent == saved.agent && it.first.machine == saved.machine }?.let { return it.first }
            return all.minByOrNull { it.second }?.first
        }
    }
}

/** The voice prefs the web owns, through the app's [Prefs] (which only keeps the bridge's keys). */
class PrefsVoicePrefs(private val prefs: Prefs) : VoicePrefs {
    override fun get(key: String): String? = prefs.voice(key)
    override fun set(key: String, value: String?) = prefs.setVoice(key, value)
}

private class AndroidPlatform(private val app: Context, private val scope: CoroutineScope) : VoiceHost.Platform {
    override fun core() = VoiceCore.bundled(app)
    override val micAllowed: Boolean
        get() = ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    override fun realtime() = RealtimeClient(app, scope)
    override fun basic() = AndroidBasicAudio(app, scope)
    override fun earcons(core: VoiceCore) = Earcons(core.earcons)
    override fun audioSession() = AudioSessionController(app)
    override fun startService() {
        ContextCompat.startForegroundService(app, VoiceService.intent(app, VoiceService.ACTION_RUN))
    }
}
