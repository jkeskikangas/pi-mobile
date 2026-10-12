package dev.pi_mobile.app.consent

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.fromHtml
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pi_mobile.app.R
import dev.pi_mobile.app.consent.AIConsent.Purpose
import dev.pi_mobile.app.ui.PiLinks
import dev.pi_mobile.app.ui.PiTheme
import dev.pi_mobile.app.ui.PrimaryButton
import dev.pi_mobile.app.ui.SecondaryButton

/** Put once at the root of the UI: shows the consent sheet whenever [prompter] has a question. */
@Composable
fun ConsentHost(prompter: ConsentPrompter) {
    prompter.pending?.let { request -> ConsentSheet(request.purpose, request.choose) }
}

/**
 * Who receives your voice, as a Material bottom sheet that opens fully. A choice is needed, but on
 * Android back and the scrim are the usual way out, so they count as Not now (the start fails with
 * [AIConsent.Declined] and the user can try again to see this sheet again).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConsentSheet(purpose: Purpose, onChoice: (Boolean) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    ModalBottomSheet(
        onDismissRequest = { onChoice(false) },
        sheetState = state,
        containerColor = PiTheme.colors.bg,
        dragHandle = null,
    ) {
        // The sheet slides away before the answer goes out (the caller then removes it).
        ConsentContent(purpose, onChoice = { ok -> scope.launch { state.hide() }.invokeOnCompletion { onChoice(ok) } })
    }
}

/**
 * The sheet's body (ConsentSheet.swift): plain words, the recipients named, Allow / Not now. Scrolls at
 * every font size while the buttons stay pinned at the bottom.
 */
@Composable
fun ConsentContent(purpose: Purpose, onChoice: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val colors = PiTheme.colors
    val uri = LocalUriHandler.current
    Column(modifier.fillMaxWidth().background(colors.bg)) {
        Column(
            Modifier
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState())
                .align(Alignment.CenterHorizontally)
                .widthIn(max = 560.dp)
                .padding(start = 24.dp, end = 24.dp, top = 28.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(48.dp).background(colors.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.GraphicEq, contentDescription = null, tint = colors.accent, modifier = Modifier.size(28.dp))
                }
                Text(
                    stringResource(R.string.consent_title),
                    style = MaterialTheme.typography.headlineLarge,
                    color = colors.text,
                    modifier = Modifier.semantics { heading() },
                )
                Text(
                    stringResource(if (purpose == Purpose.VOICE) R.string.consent_intro_voice else R.string.consent_intro_dictation),
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.muted,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Recipient(Icons.Rounded.Forum, R.string.consent_voice_title, R.string.consent_voice_text)
                Recipient(Icons.Rounded.GraphicEq, R.string.consent_basic_title, R.string.consent_basic_text)
                Recipient(Icons.Rounded.Mic, R.string.consent_dictation_title, R.string.consent_dictation_text)
                Recipient(Icons.Rounded.Lock, R.string.consent_developer_title, R.string.consent_developer_text)
            }
            Text(stringResource(R.string.consent_footer), style = MaterialTheme.typography.bodySmall, color = colors.muted)
            Column {
                LinkText(stringResource(R.string.consent_pi_privacy)) { uri.openUri(PiLinks.PRIVACY) }
                LinkText(stringResource(R.string.consent_openai_privacy)) { uri.openUri(PiLinks.OPENAI_PRIVACY) }
            }
        }
        HorizontalDivider(color = colors.border)
        val allowHint = stringResource(R.string.consent_allow_hint)
        Column(
            Modifier
                .align(Alignment.CenterHorizontally)
                .widthIn(max = 560.dp)
                .navigationBarsPadding()
                .padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            PrimaryButton(
                stringResource(R.string.consent_allow),
                onClick = { onChoice(true) },
                modifier = Modifier.semantics { onClick(label = allowHint) { onChoice(true); true } },
            )
            SecondaryButton(stringResource(R.string.consent_not_now), onClick = { onChoice(false) }, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun Recipient(icon: ImageVector, title: Int, text: Int) {
    val colors = PiTheme.colors
    val titleText = stringResource(title)
    val body = AnnotatedString.fromHtml(stringResource(text))
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.surface, RoundedCornerShape(16.dp))
            .padding(14.dp)
            .clearAndSetSemantics { contentDescription = "$titleText. $body" },
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = colors.accent, modifier = Modifier.padding(top = 2.dp).size(26.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(titleText, style = MaterialTheme.typography.titleMedium, color = colors.text)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = colors.muted)
        }
    }
}

/** A link in the text column: aligned with the words above it, 44 dp tall to hit. */
@Composable
private fun LinkText(text: String, onClick: () -> Unit) {
    Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.CenterStart) {
        Text(text, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = PiTheme.colors.accent)
    }
}
