package dev.pi_mobile.app.pairing

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.fromHtml
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.pi_mobile.app.R
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.PairingLink
import dev.pi_mobile.app.ui.Notice
import dev.pi_mobile.app.ui.PiLinks
import dev.pi_mobile.app.ui.PiMark
import dev.pi_mobile.app.ui.PiTheme
import dev.pi_mobile.app.ui.PrimaryButton
import dev.pi_mobile.app.ui.SecondaryButton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * First launch: pair with a computer by scanning the `/remote` code, or pasting its link (PairingView.swift).
 * Errors stay on this screen, next to the buttons, in words that say what to do; success is a haptic and
 * whatever [pair] does next (the app swaps this screen for the web shell).
 *
 * @param pair pairs with the computer (`HubClient.pair` + saving the machine); throws [HubError] or any
 *   exception, shown inline.
 */
@Composable
fun PairingScreen(pair: suspend (PairingLink) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val camera = rememberCameraPermission()
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var pairing by remember { mutableStateOf(false) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var pasting by rememberSaveable { mutableStateOf(false) }

    fun submit(text: String) {
        error = null
        val link = PairingLink.parse(text)
        if (link == null) {
            haptics.performHapticFeedback(HapticFeedbackType.Reject)
            error = context.getString(R.string.pairing_not_a_link)
            return
        }
        pairing = true
        scope.launch {
            try {
                pair(link)
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                haptics.performHapticFeedback(HapticFeedbackType.Reject)
                error = pairingError(e, context::getString)
            } finally {
                pairing = false
            }
        }
    }

    Box(modifier.fillMaxSize()) {
        PairingContent(
            canScan = camera.hasCamera,
            camera = camera.access,
            pairing = pairing,
            error = error,
            onScan = {
                error = null
                camera.request { ok -> if (ok) scanning = true }
            },
            onPaste = { pasting = true },
            onOpenSettings = camera::openSettings,
        )
        AnimatedVisibility(scanning, enter = fadeIn(), exit = fadeOut()) {
            BackHandler { scanning = false }
            ScannerScreen(
                onCode = { scanning = false; submit(it) },
                onPaste = { scanning = false; pasting = true },
                onClose = { scanning = false },
            )
        }
    }
    if (pasting) {
        PasteLinkSheet(onPair = { pasting = false; submit(it) }, onDismiss = { pasting = false })
    }
}

/** [HubError]s as sentences that say what to do (PairingView.message). */
internal fun pairingError(e: Throwable, string: (Int) -> String): String = when (e) {
    is HubError.Expired -> string(R.string.pairing_expired)
    is HubError.Unauthorized -> string(R.string.pairing_unauthorized)
    is HubError.Remote -> e.message ?: string(R.string.pairing_network)
    else -> string(R.string.pairing_network)
}

/** The pairing screen's look, without the camera, the permission or the network (previews and screenshots). */
@Composable
internal fun PairingContent(
    canScan: Boolean,
    camera: CameraAccess,
    pairing: Boolean,
    error: String?,
    onScan: () -> Unit,
    onPaste: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val colors = PiTheme.colors
    val scan = canScan && camera != CameraAccess.DENIED
    Column(Modifier.fillMaxSize().background(colors.bg).safeDrawingPadding()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            Column(
                Modifier
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .fillMaxWidth()
                    .padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Column(Modifier.widthIn(max = 520.dp).padding(vertical = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    PiMark(76.dp)
                    Spacer(Modifier.size(28.dp))
                    Text(
                        stringResource(R.string.pairing_title),
                        style = MaterialTheme.typography.headlineLarge,
                        color = colors.text,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics { heading() },
                    )
                    Spacer(Modifier.size(10.dp))
                    Text(
                        stringResource(R.string.pairing_subtitle),
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.muted,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.size(36.dp))
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                        StepRow(1, stringResource(R.string.pairing_step_1))
                        StepRow(2, stringResource(if (scan) R.string.pairing_step_2_scan else R.string.pairing_step_2_paste))
                    }
                    // Sit a little above centre, as on iOS.
                    Spacer(Modifier.size(48.dp))
                }
            }
        }
        Column(
            Modifier
                .align(Alignment.CenterHorizontally)
                .widthIn(max = 520.dp)
                .padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when {
                error != null -> Notice(
                    Icons.Rounded.Warning, colors.err, error,
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                canScan && camera == CameraAccess.DENIED -> Notice(Icons.Rounded.PhotoCamera, colors.needs, stringResource(R.string.camera_off)) {
                    Text(
                        stringResource(R.string.open_settings),
                        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.accent,
                        modifier = Modifier.heightIn(min = 32.dp).clickable(role = Role.Button, onClick = onOpenSettings),
                    )
                }
                canScan && camera == CameraAccess.RATIONALE ->
                    Notice(Icons.Rounded.PhotoCamera, colors.accent, stringResource(R.string.camera_rationale))
            }
            if (scan) {
                PrimaryButton(
                    stringResource(if (camera == CameraAccess.RATIONALE) R.string.camera_allow else R.string.pairing_scan),
                    onClick = onScan,
                    icon = Icons.Rounded.QrCodeScanner,
                    busy = pairing,
                    busyText = stringResource(R.string.pairing_pairing),
                )
                SecondaryButton(stringResource(R.string.pairing_paste_instead), onClick = onPaste, enabled = !pairing)
            } else {
                PrimaryButton(
                    stringResource(R.string.pairing_paste),
                    onClick = onPaste,
                    icon = Icons.Rounded.ContentPaste,
                    busy = pairing,
                    busyText = stringResource(R.string.pairing_pairing),
                )
            }
            val uri = LocalUriHandler.current
            Text(
                stringResource(R.string.privacy_policy),
                style = MaterialTheme.typography.bodySmall,
                color = colors.muted,
                modifier = Modifier
                    .heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { uri.openUri(PiLinks.PRIVACY) }
                    .padding(horizontal = 12.dp, vertical = 13.dp),
            )
        }
    }
}

@Composable
private fun StepRow(number: Int, html: String) {
    val colors = PiTheme.colors
    val text = AnnotatedString.fromHtml(html)
    val label = stringResource(R.string.pairing_step_label, number, text.text)
    Row(
        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(28.dp).background(colors.accent.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
            Text("$number", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold), color = colors.accent)
        }
        Text(text, style = MaterialTheme.typography.bodyLarge, color = colors.text)
    }
}

/**
 * Paste the `/remote` link: a field, the clipboard in one tap, and Pair. Reading the clipboard only on
 * that tap keeps Android's "pasted from your clipboard" notice tied to something the user did.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PasteLinkSheet(onPair: (String) -> Unit, onDismiss: () -> Unit) {
    val colors = PiTheme.colors
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.bg,
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                stringResource(R.string.paste_title),
                style = MaterialTheme.typography.headlineSmall,
                color = colors.text,
                modifier = Modifier.semantics { heading() },
            )
            Text(stringResource(R.string.paste_explainer), style = MaterialTheme.typography.bodyMedium, color = colors.muted)
            val label = stringResource(R.string.paste_field_label)
            TextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(stringResource(R.string.paste_placeholder), fontFamily = FontFamily.Monospace) },
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                minLines = 2,
                maxLines = 4,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { if (text.isNotBlank()) onPair(text) }),
                shape = RoundedCornerShape(12.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = colors.surface,
                    unfocusedContainerColor = colors.surface,
                    focusedIndicatorColor = colors.accent.copy(alpha = 0f),
                    unfocusedIndicatorColor = colors.accent.copy(alpha = 0f),
                ),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = label },
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = {
                        scope.launch {
                            val pasted = clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
                            if (!pasted.isNullOrBlank()) onPair(pasted)
                        }
                    },
                    shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.panel2, contentColor = colors.text),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Icon(Icons.Rounded.ContentPaste, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(8.dp))
                    Text(stringResource(R.string.paste_from_clipboard), style = MaterialTheme.typography.labelLarge)
                }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = { onPair(text) },
                    enabled = text.isNotBlank(),
                    shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.accentText),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.paste_pair), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}
