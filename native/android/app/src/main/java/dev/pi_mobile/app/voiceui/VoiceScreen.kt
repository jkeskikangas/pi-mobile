package dev.pi_mobile.app.voiceui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pi_mobile.app.R
import dev.pi_mobile.app.ui.PiTheme
import dev.pi_mobile.app.ui.rememberReducedMotion

/** The web's `HOLD_MS`: a press this long is a hold (let go to finish); shorter is a tap. */
private const val HOLD_MILLIS = 350L

/**
 * Voice mode, full screen (VoiceScreen.swift; `#voice` in `web/index.html`, `.voice` in `web/app.css`):
 * the header, the circle (orb, state, hint), captions, pi's question, and two labelled buttons, Mute and
 * End. Stateless: it draws [model] and reports taps to [actions]; only which sheet is open is its own.
 * Back ends voice mode, like End. The screen stays on while it is up.
 *
 * @param levels the current mic and pi levels; read while the orb draws (pass a snapshot-state read so
 *   level changes redraw the orb without recomposing the screen).
 * @param locked shown over the lock screen: the question is read-only and the switcher and settings ask to
 *   unlock first ([unlock] runs its block once the phone is unlocked).
 */
@Composable
fun VoiceScreen(
    model: VoiceScreenModel,
    actions: VoiceActions,
    modifier: Modifier = Modifier,
    levels: () -> VoiceLevels = { VoiceLevels() },
    locked: Boolean = false,
    unlock: (then: () -> Unit) -> Unit = { it() },
) {
    val colors = PiTheme.colors
    val reduced = rememberReducedMotion()
    val haptics = rememberVoiceHaptics()
    var showSessions by rememberSaveable { mutableStateOf(false) }
    var showSettings by rememberSaveable { mutableStateOf(false) }
    val glow by animateColorAsState(VoicePalette.pair(model.state).first, if (reduced) snap() else tween(600), label = "glow")
    val largeText = LocalDensity.current.fontScale >= 1.3f

    VoiceStateHaptics(model.state, haptics)
    BackHandler { actions.end() }
    val view = LocalView.current
    DisposableEffect(view) {
        // Awake only while voice mode is on screen; locking is fine (the call continues in the service).
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(colors.bg)
                // The state glow (`.voice` background): the state's colour at 16% fading into the page.
                val center = Offset(size.width / 2, size.height * 0.36f)
                drawRect(Brush.radialGradient(listOf(glow.copy(alpha = 0.16f), glow.copy(alpha = 0f)), center, 520.dp.toPx()))
            },
        contentAlignment = Alignment.TopCenter,
    ) {
        val question = model.question
        val middleMax = maxHeight * when {
            question == null -> 0.32f
            largeText -> 0.68f
            else -> 0.56f
        }
        Column(
            Modifier
                .widthIn(max = 560.dp)
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Over the lock screen the switcher and settings ask to unlock first.
            Header(model, onSessions = { unlock { showSessions = true } }, onSettings = { unlock { showSettings = true } })
            Stage(
                model, actions, haptics, levels,
                compact = question != null && largeText,
                still = reduced,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = if (question == null) 220.dp else if (largeText) 0.dp else 150.dp),
            )
            Column(
                Modifier.heightIn(max = middleMax).verticalScroll(rememberScrollState()).padding(bottom = 4.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Captions(model.heard, model.said, hidePi = question != null, Modifier.heightIn(min = if (question == null) 88.dp else 0.dp))
                AnimatedContent(
                    // Locked: the question only (answer it by voice); its buttons wait for an unlock.
                    targetState = if (locked) question?.copy(options = emptyList(), grace = null) else question,
                    contentKey = { it?.id },
                    transitionSpec = {
                        if (reduced) fadeIn(tween(150)) togetherWith fadeOut(tween(150))
                        else (slideInVertically(tween(280)) { it / 3 } + fadeIn(tween(280))) togetherWith fadeOut(tween(150))
                    },
                    label = "question",
                ) { q ->
                    if (q != null) {
                        QuestionCard(
                            q,
                            // Only the question on screen is answered: a late tap on a replaced card does nothing.
                            onAnswer = { actions.answer(it, q.id) },
                            onCancelGrace = actions::cancelGrace,
                            onDoItNow = actions::doItNow,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                }
                if (model.note.isNotEmpty()) {
                    Text(
                        model.note,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.warn,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
            Controls(model.muted, onMute = actions::toggleMute, onEnd = actions::end)
        }
    }
    if (showSessions && !locked) VoiceSessionSheet(model, actions, onDismiss = { showSessions = false })
    if (showSettings && !locked) VoiceSettingsSheet(model, actions, onDismiss = { showSettings = false })
}

@Composable
private fun Header(model: VoiceScreenModel, onSessions: () -> Unit, onSettings: () -> Unit) {
    val colors = PiTheme.colors
    val name = model.sessionName.ifEmpty { stringResource(R.string.voice_session) }
    val sub = listOfNotNull(model.machineName, model.sessionLine.ifEmpty { null }).joinToString(" · ")
    val label = listOfNotNull(model.sessionName, model.machineName, model.sessionLine).filter { it.isNotEmpty() }.joinToString(", ")
    val switchLabel = stringResource(R.string.voice_switch_session)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(
            Modifier
                .weight(1f)
                .heightIn(min = 48.dp)
                .clickable(onClickLabel = switchLabel, role = Role.Button, onClick = onSessions)
                .clearAndSetSemantics {
                    contentDescription = label
                    role = Role.Button
                    onClick(switchLabel) { onSessions(); true }
                },
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(model.sessionStatus, Modifier.padding(end = 10.dp))
                Text(name, style = MaterialTheme.typography.titleMedium, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null, tint = colors.muted, modifier = Modifier.size(20.dp))
            }
            if (sub.isNotEmpty()) {
                Text(sub, style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = "tnum"), color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        PressableBox(
            onClick = onSettings,
            enabled = true,
            scale = 0.92f,
            modifier = Modifier.size(48.dp).background(colors.panel2, CircleShape),
        ) {
            Icon(Icons.Rounded.Tune, contentDescription = stringResource(R.string.voice_settings), tint = colors.muted, modifier = Modifier.size(20.dp))
        }
    }
}

/**
 * The circle: one big push-to-talk target holding the orb, the state word and the hint. Hold while you
 * talk, or tap to start and stop; a press that didn't start a turn is a tap (interrupt, unmute, retry).
 * Sliding off the circle cancels a tap; a turn already started ends as on release (the web's
 * `pointercancel`), so the mic is never left held, also when the screen goes away mid-press.
 * For TalkBack it is one button that names the action it will take now.
 */
@Composable
private fun Stage(
    model: VoiceScreenModel,
    actions: VoiceActions,
    haptics: VoiceHaptics,
    levels: () -> VoiceLevels,
    compact: Boolean,
    still: Boolean,
    modifier: Modifier,
) {
    val colors = PiTheme.colors
    val current by rememberUpdatedState(actions)
    val spoken = stringResource(R.string.voice_pi_speaking)
    val value = listOf(if (model.state == VoiceState.SPEAKING) spoken else model.label, model.hint).filter { it.isNotEmpty() }.joinToString(". ")
    Column(
        modifier
            .fillMaxWidth()
            .pointerInput(Unit) {
                val slop = 32.dp.toPx()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val started = current.pressStart()
                    if (started) haptics.press()
                    var open = true
                    fun finish(inside: Boolean, at: Long) {
                        open = false
                        val held = at - down.uptimeMillis >= HOLD_MILLIS
                        if (started) {
                            current.pressEnd(held || !inside)
                            haptics.release()
                        } else if (inside) {
                            haptics.press()
                            current.tap()
                        }
                    }
                    fun inside(p: Offset) = p.x >= -slop && p.y >= -slop && p.x <= size.width + slop && p.y <= size.height + slop
                    try {
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            if (change.changedToUp()) {
                                change.consume()
                                if (open) finish(inside(change.position), change.uptimeMillis)
                                break
                            }
                            if (open && !inside(change.position)) finish(inside = false, at = change.uptimeMillis)
                        }
                    } finally {
                        // The gesture was cancelled (the screen went away): give the floor back.
                        if (open && started) current.pressEnd(true)
                    }
                }
            }
            .clearAndSetSemantics {
                contentDescription = model.stageAction
                stateDescription = value
                role = Role.Button
                onClick(model.stageAction) { current.tap(); true }
            }
            .padding(bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (!compact) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Orb(
                    model.state,
                    level = {
                        when (model.state) {
                            VoiceState.LISTENING, VoiceState.HEARING -> levels().mine
                            VoiceState.SPEAKING -> levels().pi
                            else -> 0f
                        }
                    },
                    holding = model.holding,
                    still = still,
                    modifier = Modifier.fillMaxSize(),
                )
                if (model.state == VoiceState.PAUSED) {
                    Icon(Icons.Rounded.MicOff, contentDescription = null, tint = Color.White.copy(alpha = 0.85f), modifier = Modifier.size(34.dp))
                }
            }
        }
        Text(
            model.label.ifEmpty { " " },
            style = MaterialTheme.typography.headlineMedium,
            color = colors.text,
            textAlign = TextAlign.Center,
        )
        if (!compact) {
            Text(
                model.hint.ifEmpty { " " },
                style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
                color = colors.muted,
                textAlign = TextAlign.Center,
                maxLines = 3,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

/**
 * What you said ("You ·") and what pi says, live as words arrive; clamped, never scrolled. Live text is
 * told apart by colour (contrast-tested `--text-2`), never by dimming.
 */
@Composable
private fun Captions(heard: VoiceCaption, said: VoiceCaption, hidePi: Boolean, modifier: Modifier) {
    val colors = PiTheme.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (heard.text.isNotEmpty()) {
            val you = stringResource(R.string.voice_you)
            val said = stringResource(R.string.voice_you_said, heard.text)
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.accent)) { append(you) }
                    append(heard.text)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.text2,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clearAndSetSemantics { contentDescription = said },
            )
        }
        if (said.text.isNotEmpty() && !hidePi) {
            val label = stringResource(R.string.voice_pi_said, said.text)
            Text(
                said.text,
                style = MaterialTheme.typography.titleLarge,
                color = if (said.live) colors.text2 else colors.text,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clearAndSetSemantics { contentDescription = label },
            )
        }
    }
}

/** Mute and a red End, 68–72 dp faces with labels, centred in the thumb zone (`.v-btn`). */
@Composable
private fun Controls(muted: Boolean, onMute: () -> Unit, onEnd: () -> Unit) {
    val colors = PiTheme.colors
    // 72 dp on tall phones (the web's `min-height: 760px`), 68 dp otherwise.
    val tall = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() } >= 760.dp
    val face = if (tall) 72.dp else 68.dp
    val muteLabel = stringResource(R.string.voice_mute)
    val endLabel = stringResource(R.string.voice_end_label)
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(56.dp, Alignment.CenterHorizontally)) {
        RoundButton(
            title = stringResource(if (muted) R.string.voice_unmute else R.string.voice_mute),
            icon = if (muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
            face = if (muted) colors.text else colors.panel2,
            ink = if (muted) colors.bg else colors.text,
            size = face,
            onClick = onMute,
            modifier = Modifier.semantics {
                contentDescription = muteLabel
                toggleableState = ToggleableState(muted)
                role = Role.Switch
            },
        )
        RoundButton(
            title = stringResource(R.string.voice_end),
            icon = Icons.Rounded.Close,
            face = colors.danger,
            ink = colors.dangerText,
            size = face,
            onClick = onEnd,
            modifier = Modifier.semantics { contentDescription = endLabel },
        )
    }
}

@Composable
private fun RoundButton(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    face: Color,
    ink: Color,
    size: androidx.compose.ui.unit.Dp,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    PressableBox(onClick, enabled = true, scale = 0.94f, modifier = Modifier.widthIn(min = 72.dp).then(modifier)) {
        Column(
            Modifier.clearAndSetSemantics {},
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(Modifier.size(size).background(face, CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(28.dp))
            }
            Text(title, style = MaterialTheme.typography.labelMedium, color = PiTheme.colors.muted, maxLines = 1)
        }
    }
}

/** The status dot (`.dot`): always next to the words it reinforces. */
@Composable
internal fun StatusDot(status: String, modifier: Modifier = Modifier) {
    Box(modifier.size(10.dp).background(VoicePalette.dot(status), CircleShape))
}
