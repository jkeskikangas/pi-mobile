package dev.pi_mobile.app.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.pi_mobile.app.R

/** Links the native screens show (pairing, consent, voice settings). */
object PiLinks {
    const val PRIVACY = "https://pi-mobile.dev/privacy"
    const val OPENAI_PRIVACY = "https://openai.com/policies/privacy-policy/"
}

/**
 * The app's mark: the launcher icon's π on the accent colour (the web header's mark, iOS `PiMark`).
 * Drawn from the launcher foreground so the mark and the icon can't drift apart. Decorative.
 */
@Composable
fun PiMark(size: Dp = 72.dp, modifier: Modifier = Modifier) {
    val colors = PiTheme.colors
    val shape = RoundedCornerShape(size * 0.28f)
    Box(
        modifier
            .size(size)
            .shadow(size * 0.12f, shape, ambientColor = colors.accent, spotColor = colors.accent)
            .clip(shape)
            .background(colors.accent)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        // The foreground is 108 units with the icon's face in the middle 72: scale the face to the mark.
        Image(
            painterResource(R.mipmap.ic_launcher_foreground),
            contentDescription = null,
            colorFilter = ColorFilter.tint(colors.accentText),
            modifier = Modifier.requiredSize(size * 1.5f),
        )
    }
}

/** An inline line next to its cause (docs/ui.md §4 Feedback): an icon, the sentence, an optional action. */
@Composable
fun Notice(icon: ImageVector, tint: Color, text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier
            .fillMaxWidth()
            .background(tint.copy(alpha = 0.1f), RoundedCornerShape(14.dp))
            .padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = PiTheme.colors.text)
            action?.invoke()
        }
    }
}

/**
 * The one primary action of a screen (`.btn.primary`): full width, a pill, accent fill, at the bottom.
 * While [busy] it shows a spinner and [busyText] and ignores taps.
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    busy: Boolean = false,
    busyText: String = text,
) {
    val colors = PiTheme.colors
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = colors.accent,
            contentColor = colors.accentText,
            disabledContainerColor = colors.accent.copy(alpha = if (busy) 1f else 0.45f),
            disabledContentColor = colors.accentText.copy(alpha = if (busy) 1f else 0.7f),
        ),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .semantics { if (busy) contentDescription = busyText },
    ) {
        if (busy) {
            CircularProgressIndicator(color = colors.accentText, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(busyText, style = MaterialTheme.typography.labelLarge)
        } else {
            if (icon != null) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** A quieter action under the primary one ("Paste link instead", "Not now"): text in the accent, 48 dp tall. */
@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, color: Color = PiTheme.colors.accent) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        colors = ButtonDefaults.textButtonColors(contentColor = color),
        modifier = modifier.heightIn(min = 48.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
    }
}
