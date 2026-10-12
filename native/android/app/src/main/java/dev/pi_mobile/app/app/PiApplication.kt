package dev.pi_mobile.app.app

import android.app.Application
import android.webkit.WebView
import dev.pi_mobile.app.BuildConfig
import dev.pi_mobile.app.PushCenter
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.KeystoreMachineStore
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.dictation.AudioRecorder
import dev.pi_mobile.app.dictation.Dictation
import dev.pi_mobile.app.shell.BridgeError
import dev.pi_mobile.app.consent.AIConsent
import dev.pi_mobile.app.consent.ConsentPrompter
import dev.pi_mobile.app.shell.NativeBridge
import dev.pi_mobile.app.shell.NetworkWatch
import dev.pi_mobile.app.shell.Permissions
import dev.pi_mobile.app.push.FirebaseSetup
import dev.pi_mobile.app.push.SystemNotificationPermission
import dev.pi_mobile.app.shell.ScanCenter
import dev.pi_mobile.app.shell.VoiceStarter
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * The process: one [AppModel] and the app-scoped services the shell, the bridge and (later) the voice service and
 * notifications share. Everything here outlives an activity: a dictation take or a scan belongs to the page, which
 * the activity may recreate. It is also [PushCenter.Host], so FCM callbacks find the one PushCenter.
 */
class PiApplication : Application(), PushCenter.Host {
    lateinit var model: AppModel
        private set
    lateinit var permissions: Permissions
        private set
    lateinit var dictation: Dictation
        private set
    lateinit var scanner: ScanCenter
        private set
    lateinit var network: NetworkWatch
        private set

    /** Asked only from the web's Turn on notifications; MainActivity attaches its launcher. */
    lateinit var notificationPermission: SystemNotificationPermission
        private set
    override lateinit var pushCenter: PushCenter
        private set

    /** The consent sheet's question; MainActivity draws it (ConsentHost) while it is pending. */
    val consentPrompter = ConsentPrompter()
    lateinit var aiConsent: AIConsent
        private set

    /** MainActivity is started: the consent sheet can be shown. */
    @Volatile var inFront = false

    // Implemented by voice/VoiceHost, wired here at integration.
    var voice: VoiceStarter = NoVoice

    override fun onCreate() {
        super.onCreate()
        // chrome://inspect for the shell in debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        model = AppModel(KeystoreMachineStore(this), Prefs(this))
        permissions = Permissions(this)
        aiConsent = AIConsent(getSharedPreferences(Prefs.FILE, MODE_PRIVATE), consentPrompter::ask) { inFront }
        dictation = Dictation(AudioRecorder(this, permissions), MainScope()).apply {
            consent = { aiConsent.ensure(AIConsent.Purpose.DICTATION) }
        }
        scanner = ScanCenter()
        network = NetworkWatch(this)
        // Before FCM can deliver anything; without a Firebase configuration push reports available: false.
        FirebaseSetup.init(this)
        notificationPermission = SystemNotificationPermission(this)
        pushCenter = PushCenter.create(
            this, notificationPermission,
            machines = { model.machines.value },
            // The model's client per computer; one that can't be built throws its sentence (key, origin).
            hubs = { m, method, p -> (model.client(m) ?: HubClient(m)).rpc(method, p) },
        )
        pushCenter.start()
        // A computer added or removed registers (or forgets) this phone at once.
        MainScope().launch { model.machines.drop(1).collect { pushCenter.refresh() } }
    }

    /** The bridge for a page served by [primaryOrigin]. */
    fun bridge(primaryOrigin: String) = NativeBridge(model, primaryOrigin, dictation, voice, pushCenter, aiConsent, scanner)

    // Until integration: what a build without voice mode answers (replaced by VoiceHost).

    private object NoVoice : VoiceStarter {
        override suspend fun start(agent: String, machine: String) = throw BridgeError("Voice mode isn't in this build yet.")
        override fun stop() = Unit
    }
}
