package dev.pi_mobile.app.app

import android.Manifest
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import dev.pi_mobile.app.consent.ConsentHost
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.PairingLink
import dev.pi_mobile.app.pairing.PairingScreen
import dev.pi_mobile.app.pairing.ScanOutcome
import dev.pi_mobile.app.pairing.ScannerSheet
import dev.pi_mobile.app.shell.PermissionResult
import dev.pi_mobile.app.shell.ScanResult
import dev.pi_mobile.app.shell.ShellPhase
import dev.pi_mobile.app.shell.ShellScreen
import dev.pi_mobile.app.shell.WebShell
import dev.pi_mobile.app.ui.PiTheme
import dev.pi_mobile.app.voice.VoiceHost
import dev.pi_mobile.app.voiceui.VoiceRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

/**
 * The one activity: the pairing screen until a computer is paired, then the web shell. Also receives notification
 * taps, "Answer by voice", the tile and the launcher shortcut ([LaunchRequest], run once resumed).
 */
class MainActivity : ComponentActivity(), WebShell.Host, SettingsOffer {
    private val app get() = application as PiApplication

    /** The page on screen, for voice mode's `voiceClosed`. */
    private var shell: WebShell? = null

    /** What the last intent asked for, run in [onResume]. */
    private var pendingLaunch: LaunchRequest? = null

    /** A notification tap waiting for the shell: hub machine id and session id. */
    private val pendingFocus = MutableStateFlow<Pair<String, String>?>(null)
    private var imagesDone: ((Array<Uri>?) -> Unit)? = null
    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        imagesDone?.invoke(uri?.let { arrayOf(it) })
        imagesDone = null
    }
    private val pickImages = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        imagesDone?.invoke(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        imagesDone = null
    }

    /** Where the camera writes the photo it takes for the composer (a FileProvider uri in the cache). */
    private var photo: Uri? = null
    private val takePhoto = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        imagesDone?.invoke(photo?.takeIf { ok }?.let { arrayOf(it) })
        imagesDone = null
        photo = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        app.permissions.attach(this)
        app.notificationPermission.attach(this)
        if (savedInstanceState == null) handle(intent)
        setContent { Root() }
    }

    /** Every return to the app: computers may have dropped this phone's relay registration meanwhile. */
    override fun onStart() {
        super.onStart()
        app.inFront = true
        app.settingsOffer = this
        app.pushCenter.refresh()
    }

    /**
     * The consent sheet and Settings offers need the activity on screen (AIConsent's canAsk), and a dictation take
     * can't keep the microphone in the background (Dictation.appStopped).
     */
    override fun onStop() {
        app.inFront = false
        if (app.settingsOffer === this) app.settingsOffer = null
        app.dictation.appStopped()
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        app.permissions.detach(this)
        super.onDestroy()
    }

    override fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            Toast.makeText(this, "No app on this phone opens that link.", Toast.LENGTH_SHORT).show()
        }
    }

    /** Like the iOS web view's file input: take a photo with the camera, or choose from the photo picker. */
    override fun chooseImages(multiple: Boolean, done: (Array<Uri>?) -> Unit) {
        imagesDone?.invoke(null) // a chooser the page gave up on
        imagesDone = done
        AlertDialog.Builder(this)
            .setItems(arrayOf("Take photo", if (multiple) "Choose photos" else "Choose photo")) { _, which ->
                if (which == 0) lifecycleScope.launch { capture() } else pick(multiple)
            }
            .setOnCancelListener { imagesDone?.invoke(null); imagesDone = null }
            .show()
    }

    private fun pick(multiple: Boolean) {
        val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        if (multiple) pickImages.launch(request) else pickImage.launch(request)
    }

    /** The camera app writes into a cache file this app shares with it; the app declares CAMERA, so it must hold it. */
    private suspend fun capture() {
        if (app.permissions.request(Manifest.permission.CAMERA) != PermissionResult.GRANTED) {
            Toast.makeText(this, "Camera access is off. Turn it on in Settings, or choose a photo.", Toast.LENGTH_LONG).show()
            imagesDone?.invoke(null)
            imagesDone = null
            return
        }
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", File(dir, "photo-${UUID.randomUUID()}.jpg"))
        photo = uri
        try {
            takePhoto.launch(uri)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No camera app on this phone.", Toast.LENGTH_LONG).show()
            imagesDone?.invoke(null)
            imagesDone = null
        }
    }

    private fun handle(intent: Intent?) {
        DebugLaunch.from(intent)?.let { debug(it) }
        if (intent == null) return
        // Run once the activity is resumed: voice mode may need the consent sheet, which can only be asked then.
        LaunchRequest.of(intent)?.let { pendingLaunch = it }
    }

    override fun onResume() {
        super.onResume()
        val request = pendingLaunch ?: return
        pendingLaunch = null
        when (request) {
            is LaunchRequest.Focus -> pendingFocus.value = request.machine to request.agent
            is LaunchRequest.Voice -> {
                request.notification?.let { (tag, id) -> NotificationManagerCompat.from(this).cancel(tag, id) }
                request.focus?.let { pendingFocus.value = it.machine to it.agent }
                if (request.starts) lifecycleScope.launch {
                    talk(request.agent, request.entry)?.let { Toast.makeText(this@MainActivity, request.failure(it), Toast.LENGTH_LONG).show() }
                }
            }
        }
    }

    private fun debug(d: DebugLaunch) = lifecycleScope.launch {
        if (d.reset) {
            app.model.forgetAll()
            app.aiConsent.revoke()
        }
        val link = d.pairLink?.let { PairingLink.parse(it) } ?: return@launch
        try {
            app.model.pair(link)
        } catch (e: Exception) {
            Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
        }
    }

    /** The microphone is blocked ("Don't allow" twice, or policy): only Settings can turn it back on. */
    override fun microphone(forVoice: Boolean) = offer(
        "Microphone is off",
        if (forVoice) "Allow pi to use the microphone in Settings to talk in voice mode." else "Allow pi to use the microphone in Settings to dictate.",
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)),
    )

    /** Notifications are off for pi and the system won't ask again: its notification settings. */
    override fun notifications() = offer(
        "Notifications are off",
        "Allow notifications for pi in Settings to hear when pi finishes or needs you.",
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
    )

    private fun offer(title: String, message: String, settings: Intent) {
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setNegativeButton("Not now", null)
            .setPositiveButton("Open Settings") { _, _ -> startActivity(settings) }
            .show()
    }

    @Composable
    private fun Root() {
        PiTheme {
            val machines by app.model.machines.collectAsState()
            val primary = AppModel.primaryOf(machines)
            Box(Modifier.fillMaxSize().background(PiTheme.colors.bg)) {
                if (primary == null) {
                    PairingScreen(pair = { app.model.pair(it) })
                } else {
                    // A re-paired or switched computer is a new page.
                    key(primary.id, primary.d, primary.origin) { Shell(primary) }
                }
                // Over the shell, which stays alive underneath and catches up when it closes (BRIDGE.md `voiceClosed`).
                VoiceRoute(
                    VoiceHost.shared,
                    revokeConsent = {
                        app.aiConsent.revoke()
                        app.dictation.consentRevoked()
                    },
                    onClosed = { shell?.voiceClosed() },
                )
                ForgetDialog()
                val scanning by app.scanner.isOpen.collectAsState()
                if (scanning) ScannerSheet { app.scanner.finish(it.toScanResult()) }
                ConsentHost(app.consentPrompter)
            }
        }
    }

    @Composable
    private fun Shell(primary: Machine) {
        val shell = remember { WebShell(this, primary, app.model, app.bridge(primary.origin), app.dictation, this) }
        DisposableEffect(shell) {
            this@MainActivity.shell = shell
            onDispose {
                if (this@MainActivity.shell === shell) this@MainActivity.shell = null
                shell.destroy()
            }
        }
        LaunchedEffect(shell) { shell.load() }
        val focus by pendingFocus.collectAsState()
        LaunchedEffect(focus) {
            val (m, a) = focus ?: return@LaunchedEffect
            pendingFocus.value = null
            shell.focus(m, a)
        }
        BackHandler { shell.back { moveTaskToBack(true) } }
        val web by shell.view.collectAsState()
        val phase by shell.phase.collectAsState()
        val offline = phase is ShellPhase.Offline
        // The network came back (Wi-Fi, the tailnet): try at once instead of waiting out ShellScreen's backoff.
        val changes by app.network.changes.collectAsState()
        LaunchedEffect(changes) { if (offline && app.network.online.value) shell.load() }
        var others by remember { mutableStateOf(emptyList<Machine>()) }
        var error by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(offline) {
            error = null
            others = if (offline) app.model.reachableOthers(primary) else emptyList()
        }
        ShellScreen(
            name = primary.name,
            phase = phase,
            onRetry = shell::load,
            others = others,
            onUse = { m -> try { app.model.makePrimary(m) } catch (e: Exception) { error = e.message } },
            onTalk = { lifecycleScope.launch { error = talk(null, null) } },
            error = error,
        ) {
            // Edge to edge, but the page sits inside the system bars and above the keyboard: it shrinks with the
            // IME instead of being covered (WebShell → Keyboard).
            key(web) { AndroidView({ web }, Modifier.fillMaxSize().safeDrawingPadding()) }
        }
    }

    /** Starts voice mode (it needs no web view); null, or the sentence to show. */
    private suspend fun talk(agent: String?, entry: String?): String? = try {
        app.voice.start(agent, entry)
        null
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        e.message
    }

    /** Computers the page dropped that still accept this phone: the user decides (BRIDGE.md `machines`). */
    @Composable
    private fun ForgetDialog() {
        val queue by app.model.forgetQueue.collectAsState()
        val m = queue.firstOrNull() ?: return
        AlertDialog(
            onDismissRequest = { app.model.keep(m) },
            title = { Text(if (m.name.isEmpty()) "Forget this computer on this phone?" else "Forget ${m.name} on this phone?") },
            text = { Text("It still accepts this phone. Forgetting removes its key from this phone.") },
            confirmButton = { TextButton(onClick = { app.model.forget(m) }) { Text("Forget", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { app.model.keep(m) }) { Text("Keep") } },
        )
    }
}

/** The scanner sheet's outcome as the bridge's (ScanCenter adds `busy`). */
private fun ScanOutcome.toScanResult(): ScanResult = when (this) {
    is ScanOutcome.Link -> ScanResult.Link(link)
    ScanOutcome.Cancelled -> ScanResult.Cancelled
    is ScanOutcome.Unavailable -> ScanResult.Unavailable(message)
}
