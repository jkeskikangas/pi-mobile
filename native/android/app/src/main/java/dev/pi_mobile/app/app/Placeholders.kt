package dev.pi_mobile.app.app

// Minimal stand-ins for screens other packages deliver, so this build pairs, loads the page and answers `scan`.
// Each one is replaced at integration; nothing else depends on them.

import android.webkit.WebView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.PairingLink
import dev.pi_mobile.app.shell.NetworkWatch
import dev.pi_mobile.app.shell.ScanCenter
import dev.pi_mobile.app.shell.ScanResult
import dev.pi_mobile.app.shell.ShellPhase
import kotlinx.coroutines.launch

/** Paste a pairing link. // replaced by pairing/PairingScreen at integration */
@Composable
internal fun PairingPlaceholder(model: AppModel) {
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Pair with your computer", style = MaterialTheme.typography.headlineSmall)
        Text("Run /remote in pi on your computer and paste the link here.", textAlign = TextAlign.Center)
        OutlinedTextField(text, { text = it; error = null }, Modifier.fillMaxWidth(), label = { Text("Pairing link") }, singleLine = true)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = !busy && text.isNotBlank(),
            onClick = {
                val link = PairingLink.parse(text) ?: run { error = "That isn't a pairing link."; return@Button }
                busy = true
                scope.launch {
                    try { model.pair(link) } catch (e: Exception) { error = e.message }
                    busy = false
                }
            },
        ) { Text("Pair") }
    }
}

/** Loading and offline chrome around the web view. // replaced by shell/ShellScreen at integration */
@Composable
internal fun ShellPlaceholder(machine: Machine, phase: ShellPhase, retry: () -> Unit, network: NetworkWatch, web: WebView) {
    val changes by network.changes.collectAsState()
    LaunchedEffect(changes) {
        if (phase is ShellPhase.Offline && network.online.value) retry()
    }
    Box(Modifier.fillMaxSize()) {
        // Always composed so it loads; shown only when ready (no WebView error page, no white flash).
        key(web) { AndroidView({ web }, Modifier.fillMaxSize().alpha(if (phase == ShellPhase.Ready) 1f else 0f)) }
        val name = machine.name.ifEmpty { "your computer" }
        when (phase) {
            ShellPhase.Ready -> Unit
            ShellPhase.Loading -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator()
                Text("Connecting to $name…", Modifier.padding(top = 14.dp))
            }
            is ShellPhase.Offline -> Column(
                Modifier.align(Alignment.Center).padding(28.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Can't reach $name", style = MaterialTheme.typography.headlineSmall)
                Text(phase.message, textAlign = TextAlign.Center)
                Button(onClick = retry) { Text("Try again") }
            }
        }
    }
}

/** The page's Scan, by pasting. // replaced by pairing/QrScanner in a sheet at integration */
@Composable
internal fun ScanPlaceholder(scanner: ScanCenter) {
    val open by scanner.isOpen.collectAsState()
    if (!open) return
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { scanner.finish(ScanResult.Cancelled) },
        title = { Text("Scan the code") },
        text = { OutlinedTextField(text, { text = it }, label = { Text("Pairing link") }, singleLine = true) },
        confirmButton = {
            TextButton(enabled = PairingLink.parse(text) != null, onClick = { scanner.finish(ScanResult.Link(text.trim())) }) { Text("Use") }
        },
        dismissButton = { TextButton(onClick = { scanner.finish(ScanResult.Cancelled) }) { Text("Cancel") } },
    )
}
