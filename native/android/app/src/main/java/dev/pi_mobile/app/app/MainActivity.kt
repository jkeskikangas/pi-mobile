package dev.pi_mobile.app.app

import android.app.AlertDialog
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
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.colorResource
import androidx.lifecycle.lifecycleScope
import dev.pi_mobile.app.BuildConfig
import dev.pi_mobile.app.R
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.PairingLink
import dev.pi_mobile.app.shell.ShellPhase
import dev.pi_mobile.app.shell.WebShell
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * The one activity: the pairing screen until a computer is paired, then the web shell. Also receives notification
 * taps (singleTask → [onNewIntent]): [EXTRA_AGENT] + [EXTRA_MACHINE] open that session in the page
 * (BRIDGE.md `focus`), with [EXTRA_VOICE] they start voice mode on it ("Answer by voice").
 */
class MainActivity : ComponentActivity(), WebShell.Host {
    private val app get() = application as PiApplication

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

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        app.permissions.attach(this)
        app.dictation.onDenied = { offerMicrophoneSettings() }
        if (savedInstanceState == null) handle(intent)
        setContent { Root() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        app.permissions.detach(this)
        app.dictation.onDenied = {}
        super.onDestroy()
    }

    override fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            Toast.makeText(this, "No app on this phone opens that link.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun chooseImages(multiple: Boolean, done: (Array<Uri>?) -> Unit) {
        imagesDone?.invoke(null) // a chooser the page gave up on
        imagesDone = done
        val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
        if (multiple) pickImages.launch(request) else pickImage.launch(request)
    }

    private fun handle(intent: Intent?) {
        if (BuildConfig.DEBUG) DebugLaunch.from(intent)?.let { debug(it) }
        val agent = intent?.getStringExtra(EXTRA_AGENT)?.takeIf { it.isNotEmpty() } ?: return
        val machine = intent.getStringExtra(EXTRA_MACHINE) ?: ""
        if (intent.getBooleanExtra(EXTRA_VOICE, false)) {
            // Voice mode takes the session's machines-list entry; the notification names the hub machine.
            val entry = app.model.machines.value.firstOrNull { it.machine == machine && machine.isNotEmpty() } ?: app.model.primary
            lifecycleScope.launch {
                try {
                    app.dictation.cancelIfActive()
                    app.voice.start(agent, entry?.id ?: "")
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
                }
            }
        } else {
            pendingFocus.value = machine to agent
        }
    }

    private fun debug(d: DebugLaunch) = lifecycleScope.launch {
        if (d.reset) {
            app.model.forgetAll()
            app.consent.revoke()
        }
        val link = d.pairLink?.let { PairingLink.parse(it) } ?: return@launch
        try {
            app.model.pair(link)
        } catch (e: Exception) {
            Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
        }
    }

    /** The microphone is blocked ("Don't allow" twice, or policy): only Settings can turn it back on. */
    private fun offerMicrophoneSettings() {
        AlertDialog.Builder(this)
            .setTitle("Microphone is off")
            .setMessage("Allow pi to use the microphone in Settings to dictate.")
            .setNegativeButton("Not now", null)
            .setPositiveButton("Open Settings") { _, _ ->
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }
            .show()
    }

    @Composable
    private fun Root() {
        val dark = isSystemInDarkTheme()
        // replaced by ui/Theme (PiTheme) at integration
        MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
            val machines by app.model.machines.collectAsState()
            val primary = AppModel.primaryOf(machines)
            Box(Modifier.fillMaxSize().background(colorResource(R.color.pi_background))) {
                if (primary == null) {
                    PairingPlaceholder(app.model)
                } else {
                    // A re-paired or switched computer is a new page.
                    key(primary.id, primary.d, primary.origin) { Shell(primary) }
                }
                ForgetDialog()
                ScanPlaceholder(app.scanner)
            }
        }
    }

    @Composable
    private fun Shell(primary: Machine) {
        val shell = remember { WebShell(this, primary, app.model, app.bridge(primary.origin), app.dictation, this) }
        DisposableEffect(shell) { onDispose { shell.destroy() } }
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
        // Edge to edge, but the page sits inside the system bars and above the keyboard: it shrinks with the IME
        // instead of being covered (WebShell → Keyboard).
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            ShellPlaceholder(primary, phase, retry = shell::load, network = app.network, web = web)
        }
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

    companion object {
        /** Session id the notification is about. */
        const val EXTRA_AGENT = "agent"

        /** The hub's machine id (may be empty) of that session. */
        const val EXTRA_MACHINE = "machine"

        /** "Answer by voice": start voice mode on that session instead of just opening it. */
        const val EXTRA_VOICE = "voice"
    }
}
