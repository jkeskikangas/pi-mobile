package dev.pi_mobile.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * The web's design tokens (`:root` in `web/app.css`, docs/ui.md §2.3) for one appearance. Native screens
 * sit next to the web view, so they use the same values, not Material's defaults: the page and the
 * chrome around it must not change colour when the web view appears (no flash, plans/native-android.md A15).
 */
@Immutable
data class PiColors(
    val bg: Color,
    val surface: Color,
    val panel2: Color,
    val fill2: Color,
    val segOn: Color,
    val text: Color,
    val text2: Color,
    val muted: Color,
    val border: Color,
    val borderStrong: Color,
    val accent: Color,
    val accentText: Color,
    val accentSoft: Color,
    val accentInk: Color,
    val ok: Color,
    val warn: Color,
    val warnDot: Color,
    val warnSoft: Color,
    val warnLine: Color,
    val err: Color,
    val errSoft: Color,
    val codeBg: Color,
    val busy: Color,
    val speak: Color,
    val off: Color,
    val danger: Color,
    val dangerText: Color,
    val scrim: Color,
) {
    /** `--you`: you and what you can tap. */
    val you: Color get() = accent

    /** `--needs`: pi needs you. */
    val needs: Color get() = warnDot

    companion object {
        val Light = PiColors(
            bg = Color(0xFFF7F7F5), surface = Color(0xFFFFFFFF), panel2 = Color(0xFFEFEFEB), fill2 = Color(0xFFE6E6E1),
            segOn = Color(0xFFFFFFFF), text = Color(0xFF17181A), text2 = Color(0xFF4C4F55), muted = Color(0xFF5D6066),
            border = Color(0xFFE4E4DF), borderStrong = Color(0xFFD0D0C9),
            accent = Color(0xFF2459D6), accentText = Color(0xFFFFFFFF), accentSoft = Color(0xFFE9EFFD), accentInk = Color(0xFF1C47AD),
            ok = Color(0xFF15803D), warn = Color(0xFF8A4F05), warnDot = Color(0xFFE28A0E), warnSoft = Color(0xFFFDF3E4),
            warnLine = Color(0xFFF0C98D), err = Color(0xFFC42B2B), errSoft = Color(0xFFFCECEC), codeBg = Color(0xFFF2F2EF),
            busy = Color(0xFF6A3FD0), speak = Color(0xFF0D7A70), off = Color(0xFF8B8E94),
            danger = Color(0xFFC42B2B), dangerText = Color(0xFFFFFFFF), scrim = Color(0x61111214),
        )

        /** The `--d-*` palette. */
        val Dark = PiColors(
            bg = Color(0xFF0E0F11), surface = Color(0xFF17181B), panel2 = Color(0xFF202226), fill2 = Color(0xFF2A2C31),
            segOn = Color(0xFF3A3D44), text = Color(0xFFECECEE), text2 = Color(0xFFB6B9BF), muted = Color(0xFF9A9DA4),
            border = Color(0xFF25272B), borderStrong = Color(0xFF34363B),
            accent = Color(0xFF6E9BFF), accentText = Color(0xFF08101F), accentSoft = Color(0xFF18223A), accentInk = Color(0xFFA9C3FF),
            ok = Color(0xFF4ADE80), warn = Color(0xFFF5B84A), warnDot = Color(0xFFF5B84A), warnSoft = Color(0xFF2B2112),
            warnLine = Color(0xFF5C4318), err = Color(0xFFF87171), errSoft = Color(0xFF2C1617), codeBg = Color(0xFF1B1D20),
            busy = Color(0xFFB39BFF), speak = Color(0xFF4FD1C5), off = Color(0xFF7D8189),
            danger = Color(0xFFC53030), dangerText = Color(0xFFFFFFFF), scrim = Color(0x8C000000),
        )
    }
}

private val LocalPiColors = staticCompositionLocalOf { PiColors.Light }

/** Material's roles filled from the tokens, so stock M3 components (sheets, dialogs, switches) match the web. */
private fun PiColors.scheme(dark: Boolean): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = accent, onPrimary = accentText, primaryContainer = accentSoft, onPrimaryContainer = accentInk,
        inversePrimary = accentInk,
        secondary = busy, onSecondary = Color.White, tertiary = speak, onTertiary = Color.White,
        background = bg, onBackground = text,
        surface = bg, onSurface = text, surfaceVariant = panel2, onSurfaceVariant = muted,
        surfaceTint = Color.Transparent,
        surfaceBright = surface, surfaceDim = bg,
        surfaceContainerLowest = surface, surfaceContainerLow = surface, surfaceContainer = surface,
        surfaceContainerHigh = surface, surfaceContainerHighest = panel2,
        inverseSurface = text, inverseOnSurface = bg,
        error = err, onError = dangerText, errorContainer = errSoft, onErrorContainer = err,
        outline = borderStrong, outlineVariant = border, scrim = scrim,
    )
}

/** System fonts on the web's fixed scale (docs/ui.md §2.1): pick the role, not a size. */
private val PiTypography = Typography().let { m ->
    val sans = FontFamily.Default
    fun style(size: Int, weight: Int, line: Int, tight: Boolean = false) = TextStyle(
        fontFamily = sans, fontSize = size.sp, fontWeight = FontWeight(weight), lineHeight = line.sp,
        letterSpacing = if (tight) (-0.01).em else 0.em,
    )
    m.copy(
        // Pairing and offline titles (the empty-state title, a size up on a whole screen).
        headlineLarge = style(30, 700, 36, tight = true),
        // The voice-mode state word ("Listening", "pi needs you").
        headlineMedium = style(28, 650, 34, tight = true),
        // Sheet titles.
        headlineSmall = style(21, 700, 28, tight = true),
        // pi's voice caption.
        titleLarge = style(19, 500, 26),
        // Primary names and questions.
        titleMedium = style(17, 650, 23, tight = true),
        titleSmall = style(15, 600, 20),
        bodyLarge = style(16, 400, 24),
        bodyMedium = style(15, 400, 21),
        bodySmall = style(13, 500, 18),
        // Buttons.
        labelLarge = style(16, 600, 22),
        labelMedium = style(13, 600, 18),
        // Eyebrows ("pi asks").
        labelSmall = style(12, 700, 16),
    )
}

private val PiShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(8.dp), // --r-s
    medium = RoundedCornerShape(12.dp), // --r-m: buttons, rows, inputs
    large = RoundedCornerShape(18.dp), // --r-l: cards
    extraLarge = RoundedCornerShape(24.dp), // --r-xl: sheets
)

/** The app's theme: the web tokens in the system's light or dark appearance. */
@Composable
fun PiTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) PiColors.Dark else PiColors.Light
    CompositionLocalProvider(LocalPiColors provides colors) {
        MaterialTheme(colorScheme = colors.scheme(darkTheme), typography = PiTypography, shapes = PiShapes, content = content)
    }
}

/** Token access for the composables (`PiTheme.colors.warnLine`). */
object PiTheme {
    val colors: PiColors
        @Composable @ReadOnlyComposable get() = LocalPiColors.current
}
