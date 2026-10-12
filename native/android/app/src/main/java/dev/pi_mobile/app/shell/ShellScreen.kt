package dev.pi_mobile.app.shell

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import dev.pi_mobile.app.R
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.ui.Notice
import dev.pi_mobile.app.ui.PiMark
import dev.pi_mobile.app.ui.PiTheme
import dev.pi_mobile.app.ui.PrimaryButton
import kotlinx.coroutines.delay

/** What the shell shows over the web view (ShellPhase in WebShell.swift). */
sealed interface ShellPhase {
    /** The page is loading: the mark, then "Connecting to ‹name›…" if it takes a while. */
    data object Loading : ShellPhase

    /** The page couldn't load; [message] says why (a sentence from the loader). */
    data class Offline(val message: String) : ShellPhase

    /** The web UI is up and on screen. */
    data object Ready : ShellPhase
}

/**
 * The paired app's chrome (ShellView.swift): the web UI, with native loading and offline states instead of
 * the WebView's own (never a WebView error page). The web view stays composed underneath, invisible
 * until [ShellPhase.Ready], on the page's own background, so nothing flashes white in either theme.
 * Offline retries by itself after 2, 4, 8, 15, then every 30 s while the app is in front.
 *
 * @param name the computer's name (empty: "your computer").
 * @param onRetry reload the web view (the loader then reports a new [phase]).
 * @param others other paired computers that answered while this one can't be reached: offered as "Open ‹name›".
 * @param onTalk shown with [others]: voice mode needs no web view.
 * @param error a sentence from [onUse] or [onTalk] that failed.
 * @param webView the web view (WebShell); always composed so it keeps its page.
 */
@Composable
fun ShellScreen(
    name: String,
    phase: ShellPhase,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    others: List<Machine> = emptyList(),
    onUse: (Machine) -> Unit = {},
    onTalk: () -> Unit = {},
    error: String? = null,
    webView: @Composable () -> Unit,
) {
    val ready = phase == ShellPhase.Ready
    // Automatic tries since the last successful load: survives the Offline → Loading → Offline round trips.
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(ready) { if (ready) attempt = 0 }
    Box(modifier.fillMaxSize().background(PiTheme.colors.bg)) {
        Box(
            Modifier
                .fillMaxSize()
                .alpha(if (ready) 1f else 0f)
                .then(if (ready) Modifier else Modifier.clearAndSetSemantics {}),
        ) { webView() }
        AnimatedContent(
            targetState = phase,
            contentKey = { it::class },
            transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(200)) },
            label = "shell",
        ) { p ->
            when (p) {
                ShellPhase.Loading -> LoadingView(name)
                is ShellPhase.Offline -> OfflineView(
                    name, p.message, attempt,
                    onAutoRetry = { attempt++; onRetry() },
                    onRetry = onRetry, others = others, onUse = onUse, onTalk = onTalk, error = error,
                )
                ShellPhase.Ready -> Box(Modifier)
            }
        }
    }
}

/** The mark; a spinner and "Connecting to ‹name›…" only once loading is noticeably slow (most loads finish first). */
@Composable
private fun LoadingView(name: String) {
    var slow by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(600)
        slow = true
    }
    val label = if (name.isEmpty()) stringResource(R.string.shell_connecting) else stringResource(R.string.shell_connecting_to, name)
    Column(
        Modifier.fillMaxSize().clearAndSetSemantics { contentDescription = label },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
    ) {
        PiMark(64.dp)
        AnimatedVisibility(slow, enter = fadeIn(tween(200))) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                CircularProgressIndicator(color = PiTheme.colors.muted, strokeWidth = 2.5.dp, modifier = Modifier.size(24.dp))
                Text(label, style = MaterialTheme.typography.bodyMedium, color = PiTheme.colors.muted)
            }
        }
    }
}

/** Seconds to wait before each automatic retry; the last one repeats. */
private val BACKOFF = listOf(2, 4, 8, 15, 30)

@Composable
private fun OfflineView(
    name: String,
    message: String,
    attempt: Int,
    onAutoRetry: () -> Unit,
    onRetry: () -> Unit,
    others: List<Machine>,
    onUse: (Machine) -> Unit,
    onTalk: () -> Unit,
    error: String?,
) {
    val colors = PiTheme.colors
    val haptics = LocalHapticFeedback.current
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val inFront = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    var wentAway by remember { mutableStateOf(false) }
    var retryIn by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(attempt, inFront) {
        if (!inFront) {
            wentAway = true
            retryIn = null
            return@LaunchedEffect
        }
        // Back in the app: try at once instead of waiting out the backoff.
        if (wentAway) {
            wentAway = false
            return@LaunchedEffect onRetry()
        }
        for (left in BACKOFF[minOf(attempt, BACKOFF.lastIndex)] downTo 1) {
            retryIn = left
            delay(1000)
        }
        retryIn = null
        onAutoRetry()
    }
    val advice = stringResource(R.string.shell_offline_advice)
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        BoxWithConstraints(Modifier.weight(1f).widthIn(max = 520.dp)) {
            Column(
                Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).fillMaxWidth().padding(vertical = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Rounded.WifiOff, contentDescription = null, tint = colors.muted, modifier = Modifier.size(52.dp))
                Spacer(Modifier.size(20.dp))
                Text(
                    if (name.isEmpty()) stringResource(R.string.shell_cant_reach_yours) else stringResource(R.string.shell_cant_reach, name),
                    style = MaterialTheme.typography.headlineSmall,
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    if (message.startsWith("Can't reach") || message.startsWith("Can’t reach")) advice else "$message $advice",
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.muted,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.size(14.dp))
                Row(
                    Modifier.semantics(mergeDescendants = true) {},
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val left = retryIn
                    if (left == null) CircularProgressIndicator(color = colors.muted, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
                    Text(
                        if (left == null) stringResource(R.string.shell_retrying) else stringResource(R.string.shell_retry_in, left),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.muted,
                    )
                }
                if (error != null) {
                    Spacer(Modifier.size(16.dp))
                    Notice(Icons.Rounded.Warning, colors.err, error, Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
        }
        Column(
            Modifier.widthIn(max = 520.dp).padding(top = 12.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (others.isNotEmpty()) {
                others.forEach { m ->
                    SecondaryAction(
                        if (m.name.isEmpty()) stringResource(R.string.shell_open_other_unnamed) else stringResource(R.string.shell_open_other, m.name),
                        Icons.Rounded.Computer,
                    ) { onUse(m) }
                }
                SecondaryAction(stringResource(R.string.shell_talk), Icons.Rounded.GraphicEq, onTalk)
            }
            PrimaryButton(
                stringResource(R.string.shell_try_again),
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.VirtualKey)
                    retryIn = null
                    onRetry()
                },
                icon = Icons.Rounded.Refresh,
                enabled = retryIn != null,
            )
        }
    }
}

@Composable
private fun SecondaryAction(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        shape = CircleShape,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = PiTheme.colors.accent),
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
        Spacer(Modifier.size(8.dp))
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}
