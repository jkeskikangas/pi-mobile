package dev.pi_mobile.app.voiceui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import dev.pi_mobile.app.ui.PiTheme

/**
 * The voice screen's state colours: the web's vivid dark-palette colours (`--d-*`), the same in both
 * themes (`.voice[data-state]` `--c1`/`--c2`), so a state looks the same wherever you see it
 * (design-principles.md §4). Everything else on the screen uses the app's tokens ([PiTheme.colors]).
 */
object VoicePalette {
    val accent = Color(0xFF6E9BFF) // --d-accent (you)
    val you2 = Color(0xFF57D0F0) // --d-you-2
    val busy = Color(0xFFB39BFF) // --d-busy (pi working)
    val busy2 = Color(0xFFE58CF9) // --d-busy-2
    val speak = Color(0xFF4FD1C5) // --d-speak
    val speak2 = Color(0xFF7EE8B5) // --d-speak-2
    val needs = Color(0xFFF5B84A) // --d-warn-dot (pi needs you)
    val needs2 = Color(0xFFFB923C) // --d-needs-2
    val off = Color(0xFF7D8189) // --d-off
    val offMuted = Color(0xFF9A9DA4) // --d-muted

    /** `--c1`, `--c2` for a state. */
    fun pair(state: VoiceState): Pair<Color, Color> = when (state) {
        VoiceState.LISTENING, VoiceState.HEARING -> accent to you2
        VoiceState.THINKING -> accent to busy
        VoiceState.WORKING -> busy to busy2
        VoiceState.SPEAKING -> speak to speak2
        VoiceState.ASKING -> needs to needs2
        VoiceState.PAUSED, VoiceState.CONNECTING, VoiceState.OFFLINE -> off to offMuted
    }

    /** Grey states: the orb dims and, once its colour has eased in, stops moving. */
    fun isDim(state: VoiceState) = state == VoiceState.PAUSED || state == VoiceState.CONNECTING || state == VoiceState.OFFLINE

    /** The status dot (`.dot` in `web/app.css`): needs you amber, working violet, idle green; app tokens, not the vivid ones. */
    @Composable @ReadOnlyComposable
    fun dot(status: String): Color = when (status) {
        "waiting" -> PiTheme.colors.needs
        "working" -> PiTheme.colors.busy
        "idle" -> PiTheme.colors.ok
        else -> PiTheme.colors.fill2
    }
}
