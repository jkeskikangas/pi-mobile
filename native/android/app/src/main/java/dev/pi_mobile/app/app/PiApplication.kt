package dev.pi_mobile.app.app

import android.app.Application
import android.content.pm.PackageManager
import android.webkit.WebView
import dev.pi_mobile.app.BuildConfig
import dev.pi_mobile.app.PushCenter
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.KeystoreMachineStore
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.dictation.AudioRecorder
import dev.pi_mobile.app.dictation.Dictation
import dev.pi_mobile.app.shell.BridgeError
import dev.pi_mobile.app.shell.ConsentController
import dev.pi_mobile.app.shell.ConsentKind
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

    // Implemented by other packages and wired here at integration: voice/VoiceHost, consent/AIConsent.
    var voice: VoiceStarter = NoVoice
    var consent: ConsentController = NoConsent

    override fun onCreate() {
        super.onCreate()
        // chrome://inspect for the shell in debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        model = AppModel(KeystoreMachineStore(this), Prefs(this))
        permissions = Permissions(this)
        dictation = Dictation(AudioRecorder(this, permissions), MainScope()).apply {
            consent = { this@PiApplication.consent.ensure(ConsentKind.DICTATION) }
        }
        scanner = ScanCenter(permissions) { packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
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
    fun bridge(primaryOrigin: String) = NativeBridge(model, primaryOrigin, dictation, voice, pushCenter, consent, scanner)

    // Until integration: what a build without these features answers (replaced by the real implementations).

    private object NoVoice : VoiceStarter {
        override suspend fun start(agent: String, machine: String) = throw BridgeError("Voice mode isn't in this build yet.")
        override fun stop() = Unit
    }

    private object NoConsent : ConsentController {
        override suspend fun granted() = false
        override suspend fun ensure(kind: ConsentKind) = throw BridgeError("pi can't ask for your OK to send your voice in this build yet.")
        override fun revoke() = Unit
    }
}
