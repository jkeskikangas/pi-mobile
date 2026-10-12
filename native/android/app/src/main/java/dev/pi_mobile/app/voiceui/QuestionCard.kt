package dev.pi_mobile.app.voiceui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.withInfiniteAnimationFrameMillis
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pi_mobile.app.R
import dev.pi_mobile.app.ui.PiTheme
import dev.pi_mobile.app.ui.rememberReducedMotion
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * pi's question as the app's question card (`.prompt`, `renderAsk` in `web/voice.js`, QuestionCard.swift):
 * "pi asks", the title, the message and tap answers (destructive in red, naming what they do); during the
 * undo window "Going ahead", a shrinking amber bar, Cancel (primary) and Do it now. Key it by the
 * question's id at the call site: a new question is a new card, with no busy state carried over.
 */
@Composable
fun QuestionCard(
    question: VoiceQuestion,
    onAnswer: suspend (VoiceQuestion.Option) -> Unit,
    onCancelGrace: () -> Unit,
    onDoItNow: suspend () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = PiTheme.colors
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val run: (suspend () -> Unit) -> Unit = { work ->
        if (!busy) {
            busy = true
            scope.launch { try { work() } finally { busy = false } }
        }
    }
    val shape = RoundedCornerShape(18.dp)
    Column(
        modifier
            .fillMaxWidth()
            .shadow(20.dp, shape, ambientColor = Color.Black.copy(alpha = 0.16f), spotColor = Color.Black.copy(alpha = 0.16f))
            .background(colors.surface, shape)
            .border(1.dp, colors.warnLine, shape)
            .padding(16.dp),
    ) {
        val grace = question.grace
        if (grace != null) {
            GraceBody(question.title, grace, onCancel = onCancelGrace, onDoItNow = { run(onDoItNow) }, enabled = !busy)
        } else {
            AskBody(question, enabled = !busy) { option -> run { onAnswer(option) } }
        }
    }
}

/** Accessibility text sizes: two answers side by side won't fit, so they stack. */
@Composable
private fun largeText() = LocalDensity.current.fontScale >= 1.3f

@Composable
private fun Eyebrow(text: String) {
    Row(
        Modifier.padding(bottom = 6.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = PiTheme.colors.warn, modifier = Modifier.size(15.dp))
        Text(text, style = MaterialTheme.typography.labelSmall, color = PiTheme.colors.warn)
    }
}

@Composable
private fun AskBody(question: VoiceQuestion, enabled: Boolean, send: (VoiceQuestion.Option) -> Unit) {
    val colors = PiTheme.colors
    Eyebrow(stringResource(R.string.voice_pi_asks))
    Text(
        question.title,
        style = MaterialTheme.typography.titleMedium,
        color = colors.text,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
    if (!question.message.isNullOrEmpty()) {
        Text(
            question.message,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Normal),
            color = colors.muted,
            maxLines = 6,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(top = 8.dp)
                .fillMaxWidth()
                .background(colors.codeBg, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        )
    }
    if (question.options.isEmpty()) {
        Text(stringResource(R.string.voice_say_answer), style = MaterialTheme.typography.bodyMedium, color = colors.text, modifier = Modifier.padding(top = 8.dp))
        return
    }
    val actions = question.options.filter { !it.ghost }
    val ghosts = question.options.filter { it.ghost }
    val sideBySide = question.kind == "confirm" && actions.size == 2
    Box(Modifier.padding(top = 14.dp)) {
        if (sideBySide && !largeText()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                actions.forEach { AnswerButton(it, leading = false, enabled = enabled, modifier = Modifier.weight(1f)) { send(it) } }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                actions.forEach { AnswerButton(it, leading = !sideBySide, enabled = enabled, modifier = Modifier.fillMaxWidth()) { send(it) } }
            }
        }
    }
    ghosts.forEach { o ->
        Box(
            Modifier
                .padding(top = 4.dp)
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(enabled = enabled, role = Role.Button) { send(o) },
            contentAlignment = Alignment.Center,
        ) {
            Text(o.label, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium), color = colors.muted)
        }
    }
}

@Composable
private fun AnswerButton(o: VoiceQuestion.Option, leading: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val colors = PiTheme.colors
    val fill = when {
        o.destructive -> colors.danger
        o.primary -> colors.accent
        else -> colors.panel2
    }
    val ink = when {
        o.destructive -> colors.dangerText
        o.primary -> colors.accentText
        else -> colors.text
    }
    val destructive = stringResource(R.string.voice_destructive)
    PressableBox(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .heightIn(min = 48.dp)
            .background(fill, RoundedCornerShape(12.dp))
            .semantics { if (o.destructive) stateDescription = destructive },
        contentAlignment = if (leading) Alignment.CenterStart else Alignment.Center,
    ) {
        Text(
            o.label,
            style = MaterialTheme.typography.bodyLarge.copy(
                fontWeight = if (leading && !o.primary && !o.destructive) FontWeight.Medium else FontWeight.SemiBold,
            ),
            color = ink,
            textAlign = if (leading) TextAlign.Start else TextAlign.Center,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
    }
}

@Composable
private fun GraceBody(title: String, grace: VoiceQuestion.Grace, onCancel: () -> Unit, onDoItNow: () -> Unit, enabled: Boolean) {
    val colors = PiTheme.colors
    val reduced = rememberReducedMotion()
    // The bar shrinks smoothly; the seconds re-render with it (once a second with reduced motion).
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(grace, reduced) {
        while (now < grace.untilMillis) {
            if (reduced) delay(1000) else withInfiniteAnimationFrameMillis {}
            now = System.currentTimeMillis()
        }
    }
    Eyebrow(stringResource(R.string.voice_going_ahead))
    Text(title.replace(Regex("\\?\\s*$"), ""), style = MaterialTheme.typography.titleMedium, color = colors.text)
    Text(
        stringResource(R.string.voice_going_ahead_in, grace.secondsLeft(now)),
        style = MaterialTheme.typography.bodyMedium,
        color = colors.text,
        modifier = Modifier.padding(top = 8.dp),
    )
    Box(
        Modifier
            .padding(top = 12.dp)
            .fillMaxWidth()
            .height(6.dp)
            .background(colors.fill2, RoundedCornerShape(50))
            .clearAndSetSemantics {},
    ) {
        Box(Modifier.fillMaxWidth(grace.fraction(now)).height(6.dp).background(VoicePalette.needs, RoundedCornerShape(50)))
    }
    val buttons: @Composable (Modifier) -> Unit = { m ->
        GraceButton(stringResource(R.string.cancel), colors.accent, colors.accentText, enabled, m, onCancel)
        GraceButton(stringResource(R.string.voice_do_it_now), colors.panel2, colors.text, enabled, m, onDoItNow)
    }
    Box(Modifier.padding(top = 14.dp)) {
        if (largeText()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { buttons(Modifier.fillMaxWidth()) }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { buttons(Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun GraceButton(text: String, fill: Color, ink: Color, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    PressableBox(onClick, enabled, modifier.heightIn(min = 48.dp).background(fill, RoundedCornerShape(12.dp))) {
        Text(text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold), color = ink, maxLines = 1, modifier = Modifier.padding(horizontal = 12.dp))
    }
}

/**
 * A big button with the web's `:active` press: a slight scale, or a dim with reduced motion. No ripple:
 * the filled faces already say they're buttons and the scale is the feedback.
 */
@Composable
internal fun PressableBox(
    onClick: () -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    scale: Float = 0.96f,
    contentAlignment: Alignment = Alignment.Center,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val reduced = rememberReducedMotion()
    val shrink by animateFloatAsState(if (pressed && !reduced) scale else 1f, tween(120), label = "press")
    Box(
        modifier
            .scale(shrink)
            .alpha(if (pressed && reduced) 0.7f else if (enabled) 1f else 0.6f)
            .clickable(interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = contentAlignment,
    ) { content() }
}
