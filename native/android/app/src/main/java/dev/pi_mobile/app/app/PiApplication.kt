package dev.pi_mobile.app.app

import android.app.Application
import android.content.pm.PackageManager
import android.webkit.WebView
import dev.pi_mobile.app.BuildConfig
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
import dev.pi_mobile.app.shell.PushController
import dev.pi_mobile.app.shell.ScanCenter
import dev.pi_mobile.app.shell.VoiceStarter
import dev.pi_mobile.app.core.obj
import kotlinx.coroutines.MainScope

/**
 * The process: one [AppModel] and the app-scoped services the shell, the bridge and (later) the voice service and
 * notifications share. Everything here outlives an activity: a dictation take or a scan belongs to the page, which
 * the activity may recreate.
 */
class PiApplication : Application() {
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

    // Implemented by other packages and wired here at integration: voice/VoiceHost, app/PushCenter, consent/AIConsent.
    var voice: VoiceStarter = NoVoice
    var push: PushController = NoPush
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
    }

    /** The bridge for a page served by [primaryOrigin]. */
    fun bridge(primaryOrigin: String) = NativeBridge(model, primaryOrigin, dictation, voice, push, consent, scanner)

    // Until integration: what a build without these features answers (replaced by the real implementations).

    private object NoVoice : VoiceStarter {
        override suspend fun start(agent: String, machine: String) = throw BridgeError("Voice mode isn't in this build yet.")
        override fun stop() = Unit
    }

    /** BRIDGE.md `push.status` for a build without push (`available: false`, plans/native-android.md A14). */
    private object NoPush : PushController {
        private val off = obj("on" to false, "permission" to "default", "available" to false, "computers" to emptyList<Any>())
        override suspend fun status() = off
        override suspend fun enable(on: Boolean) = throw BridgeError("Notifications aren't available in this build.")
    }

    private object NoConsent : ConsentController {
        override suspend fun granted() = false
        override suspend fun ensure(kind: ConsentKind) = throw BridgeError("pi can't ask for your OK to send your voice in this build yet.")
        override fun revoke() = Unit
    }
}
