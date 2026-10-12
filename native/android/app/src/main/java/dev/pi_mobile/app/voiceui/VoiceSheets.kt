package dev.pi_mobile.app.voiceui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.PanTool
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.pi_mobile.app.R
import dev.pi_mobile.app.ui.PiLinks
import dev.pi_mobile.app.ui.PiTheme
import kotlinx.coroutines.launch

/** The session switcher as a bottom sheet; picking a session follows it and closes the sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceSessionSheet(model: VoiceScreenModel, actions: VoiceActions, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(), containerColor = PiTheme.colors.bg) {
        VoiceSessionList(model, onDone = onDismiss, onPick = { s ->
            if (s.agent != model.agent || s.machine != model.machineId) actions.switchSession(s.agent, s.machine)
            onDismiss()
        })
    }
}

/** `urgency()` in `web/app.js`: what needs you first, then what is working, then the rest. */
private fun urgency(s: VoiceSessionItem) = when {
    s.waiting > 0 || s.status == "waiting" -> 0
    s.status == "working" -> 1
    else -> 2
}

/** Every reachable session, grouped as the web's (VoiceSessionSheet in VoiceSheets.swift). */
@Composable
fun VoiceSessionList(model: VoiceScreenModel, onDone: () -> Unit, onPick: (VoiceSessionItem) -> Unit) {
    val colors = PiTheme.colors
    SheetPage(stringResource(R.string.voice_talk_to), onDone) {
        if (model.sessions.isEmpty()) {
            Text(
                stringResource(R.string.voice_no_sessions),
                style = MaterialTheme.typography.bodyLarge,
                color = colors.muted,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
            )
        }
        listOf(R.string.voice_group_needs_you, R.string.voice_group_working, R.string.voice_group_idle).forEachIndexed { rank, title ->
            val items = model.sessions.filter { urgency(it) == rank }
            if (items.isNotEmpty()) {
                Section(stringResource(title)) {
                    items.forEachIndexed { i, s ->
                        if (i > 0) Hairline()
                        val current = s.agent == model.agent && s.machine == model.machineId
                        val status = when {
                            s.waiting > 0 -> stringResource(R.string.voice_group_needs_you)
                            s.status == "waiting" -> stringResource(R.string.voice_sub_terminal)
                            s.status == "working" -> stringResource(R.string.voice_group_working)
                            else -> null
                        }
                        ListRow(
                            title = s.name.ifEmpty { stringResource(R.string.voice_session) },
                            sub = listOfNotNull(s.machineName, status).joinToString(" · ").ifEmpty { null },
                            lead = { StatusDot(if (urgency(s) == 0) "waiting" else s.status) },
                            selected = current,
                            onClick = { onPick(s) },
                        )
                    }
                }
            }
        }
    }
}

/** Voice settings as a bottom sheet; the voice picker opens inside it, and back returns to the settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceSettingsSheet(model: VoiceScreenModel, actions: VoiceActions, onDismiss: () -> Unit) {
    var personas by rememberSaveable { mutableStateOf(false) }
    var confirmRevoke by rememberSaveable { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(), containerColor = PiTheme.colors.bg) {
        if (personas) {
            BackHandler { personas = false }
            VoicePersonaList(model, actions, onBack = { personas = false }, onDone = onDismiss)
        } else {
            VoiceSettingsContent(model, actions, onDone = onDismiss, onVoices = { personas = true }, onRevoke = { confirmRevoke = true })
        }
    }
    if (confirmRevoke) {
        AlertDialog(
            onDismissRequest = { confirmRevoke = false },
            title = { Text(stringResource(R.string.voice_stop_sharing_title)) },
            text = { Text(stringResource(R.string.voice_stop_sharing_message)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmRevoke = false
                    onDismiss()
                    actions.revokeConsent()
                }) { Text(stringResource(R.string.voice_stop_sharing_confirm), color = PiTheme.colors.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmRevoke = false }) { Text(stringResource(R.string.cancel)) } },
            containerColor = PiTheme.colors.surface,
        )
    }
}

/**
 * Voice settings (`#vSettings`): Eyes-free | Can glance, Open mic | Push to talk, the voice, why basic
 * voice is in use when it is, Stop sharing my voice and the privacy policy.
 */
@Composable
fun VoiceSettingsContent(model: VoiceScreenModel, actions: VoiceActions, onDone: () -> Unit, onVoices: () -> Unit, onRevoke: () -> Unit) {
    val s = model.settings
    val uri = LocalUriHandler.current
    SheetPage(stringResource(R.string.voice_settings), onDone) {
        Section(
            stringResource(R.string.voice_attention_header),
            footer = stringResource(if (s.attention == VoiceAttention.EYES_BUSY) R.string.voice_eyes_free_footer else R.string.voice_glance_footer),
            grouped = false,
        ) {
            Seg(
                listOf(VoiceAttention.EYES_BUSY to R.string.voice_eyes_free, VoiceAttention.GLANCE to R.string.voice_can_glance),
                selected = s.attention,
                onSelect = actions::setAttention,
            )
        }
        Section(
            stringResource(R.string.voice_turns_header),
            footer = stringResource(if (s.turns == VoiceTurns.OPEN) R.string.voice_open_mic_footer else R.string.voice_ptt_footer),
            grouped = false,
        ) {
            Seg(
                listOf(VoiceTurns.OPEN to R.string.voice_open_mic, VoiceTurns.TAP to R.string.voice_push_to_talk),
                selected = s.turns,
                onSelect = actions::setTurns,
            )
        }
        val engine = when {
            model.engineKind != VoiceEngineKind.BASIC -> stringResource(R.string.voice_realtime)
            s.basicReason != null -> stringResource(R.string.voice_basic_because, s.basicReason)
            else -> stringResource(R.string.voice_basic)
        }
        Section(stringResource(R.string.voice_voice_header), footer = "$engine ${stringResource(R.string.voice_say_settings)}") {
            val p = s.personas.firstOrNull { it.id == s.persona } ?: s.personas.firstOrNull()
            ListRow(
                title = p?.name ?: stringResource(R.string.voice_choose),
                sub = p?.blurb ?: stringResource(R.string.voice_choose_sub),
                lead = { RowIcon(Icons.Rounded.GraphicEq) },
                trail = { Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = PiTheme.colors.muted) },
                enabled = s.personas.isNotEmpty(),
                onClick = onVoices,
            )
        }
        Section(stringResource(R.string.voice_privacy_header), footer = stringResource(R.string.voice_privacy_footer)) {
            ListRow(
                title = stringResource(R.string.voice_stop_sharing),
                lead = { RowIcon(Icons.Rounded.PanTool, PiTheme.colors.danger) },
                color = PiTheme.colors.danger,
                onClick = onRevoke,
            )
            Hairline()
            ListRow(
                title = stringResource(R.string.privacy_policy),
                lead = { RowIcon(Icons.Rounded.Lock) },
                color = PiTheme.colors.accent,
                onClick = { uri.openUri(PiLinks.PRIVACY) },
            )
        }
    }
}

/**
 * The voice picker (`voiceSheet()`): the computer's personas; choosing one plays its sample. A pick
 * while the previous one is still being applied (a realtime call redials) waits, and rapid picks
 * coalesce to the latest instead of overlapping redials.
 */
@Composable
fun VoicePersonaList(model: VoiceScreenModel, actions: VoiceActions, onBack: () -> Unit, onDone: () -> Unit) {
    val colors = PiTheme.colors
    val scope = rememberCoroutineScope()
    var applying by remember { mutableStateOf<String?>(null) }
    val pending = remember { arrayOfNulls<String>(1) }
    fun choose(id: String) {
        if (applying != null) {
            pending[0] = id
            return
        }
        scope.launch {
            var next: String? = id
            while (next != null) {
                applying = next
                // No call to speak through (connecting, or the mic failed): the phone's closest voice, as the web does.
                if (model.engineKind == null) actions.playSample(next)
                actions.setPersona(next)
                next = pending[0]
                pending[0] = null
            }
            applying = null
        }
    }
    val s = model.settings
    SheetPage(stringResource(R.string.voice_voice_header), onDone, onBack = onBack) {
        Section(null, footer = stringResource(R.string.voice_persona_footer), note = model.note.ifEmpty { null }) {
            Column(Modifier.selectableGroup()) {
                s.personas.forEachIndexed { i, p ->
                    if (i > 0) Hairline()
                    ListRow(
                        title = p.name,
                        sub = p.blurb,
                        selected = p.id == s.persona && applying != p.id,
                        busy = applying == p.id,
                        onClickLabel = stringResource(R.string.voice_plays_sample),
                        onClick = { choose(p.id) },
                    )
                }
            }
        }
    }
}

/** A sheet page: the title, Done, an optional back arrow, and its sections scrolling under them. */
@Composable
private fun SheetPage(title: String, onDone: () -> Unit, onBack: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val colors = PiTheme.colors
    Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = stringResource(R.string.back), tint = colors.text)
                }
            }
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall,
                color = colors.text,
                modifier = Modifier.weight(1f).padding(start = if (onBack == null) 8.dp else 0.dp).semantics { heading() },
            )
            TextButton(onClick = onDone, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.done), style = MaterialTheme.typography.labelLarge, color = colors.accent)
            }
        }
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            content = content,
        )
    }
}

/** A section (`.section` + `.group`): a label, a grouped surface (or a bare control), and a footnote. */
@Composable
private fun Section(
    header: String?,
    footer: String? = null,
    grouped: Boolean = true,
    note: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = PiTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (header != null) {
            Text(header, style = MaterialTheme.typography.labelMedium, color = colors.muted, modifier = Modifier.padding(horizontal = 4.dp).semantics { heading() })
        }
        Column(if (grouped) Modifier.fillMaxWidth().background(colors.surface, RoundedCornerShape(18.dp)) else Modifier.fillMaxWidth(), content = content)
        if (note != null) Text(note, style = MaterialTheme.typography.bodySmall, color = colors.warn, modifier = Modifier.padding(horizontal = 4.dp))
        if (footer != null) {
            Text(footer, style = MaterialTheme.typography.bodySmall, color = colors.muted, modifier = Modifier.padding(horizontal = 4.dp))
        }
    }
}

/** A row (`row()`): 52 dp, a lead, title and sub, and a trailing check when selected. */
@Composable
private fun ListRow(
    title: String,
    onClick: () -> Unit,
    sub: String? = null,
    lead: (@Composable () -> Unit)? = null,
    trail: (@Composable () -> Unit)? = null,
    selected: Boolean = false,
    busy: Boolean = false,
    enabled: Boolean = true,
    color: Color = PiTheme.colors.text,
    onClickLabel: String? = null,
) {
    val colors = PiTheme.colors
    val switching = stringResource(R.string.voice_switching)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(enabled = enabled, onClickLabel = onClickLabel, role = Role.Button, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        lead?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (enabled) color else colors.muted)
            if (sub != null) Text(sub, style = MaterialTheme.typography.bodyMedium, color = colors.muted)
        }
        when {
            busy -> CircularProgressIndicator(
                color = colors.muted, strokeWidth = 2.dp,
                modifier = Modifier.size(18.dp).semantics { contentDescription = switching },
            )
            selected -> Icon(Icons.Rounded.Check, contentDescription = null, tint = colors.accent)
            trail != null -> trail()
        }
    }
}

@Composable
private fun RowIcon(icon: ImageVector, tint: Color = PiTheme.colors.accent) {
    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
}

/** The inset hairline between rows of a group. */
@Composable
private fun Hairline() {
    HorizontalDivider(Modifier.padding(start = 16.dp), color = PiTheme.colors.border)
}

/**
 * A two-way choice (`.seg.wide`): a pill track, the selected option lifted on `--seg-on`. Each option is
 * a 44 dp radio target, so TalkBack reads it as one of two.
 */
@Composable
private fun <T> Seg(options: List<Pair<T, Int>>, selected: T, onSelect: (T) -> Unit) {
    val colors = PiTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.fill2, CircleShape)
            .padding(3.dp)
            .selectableGroup(),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .then(if (on) Modifier.shadow(1.dp, CircleShape).background(colors.segOn, CircleShape) else Modifier)
                    .selectable(selected = on, role = Role.RadioButton) { if (!on) onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(label),
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium),
                    color = if (on) colors.text else colors.muted,
                )
            }
        }
    }
}
