package dev.pi_mobile.app.voiceui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView

/**
 * Haptics the web can't do outside a gesture (VoiceHaptics.swift): a light tick on press and release, and
 * a distinct one on the state changes that matter (pi asks, pi is done, something failed). Through
 * [View.performHapticFeedback], which follows the user's touch-feedback setting and needs no VIBRATE permission.
 */
class VoiceHaptics(private val view: View) {
    fun press() = perform(HapticFeedbackConstants.VIRTUAL_KEY)

    fun release() = perform(if (Build.VERSION.SDK_INT >= 27) HapticFeedbackConstants.VIRTUAL_KEY_RELEASE else HapticFeedbackConstants.CLOCK_TICK)

    fun asking() = perform(HapticFeedbackConstants.LONG_PRESS)

    fun done() = perform(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK)

    fun failed() = perform(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)

    private fun perform(constant: Int) {
        view.performHapticFeedback(constant)
    }
}

@Composable
fun rememberVoiceHaptics(): VoiceHaptics {
    val view = LocalView.current
    return remember(view) { VoiceHaptics(view) }
}

/** The state-change haptics (`voiceHaptics` modifier in Swift): asking, done working, gone offline. */
@Composable
internal fun VoiceStateHaptics(state: VoiceState, haptics: VoiceHaptics) {
    val previous = remember { arrayOf(state) }
    LaunchedEffect(state) {
        val old = previous[0]
        previous[0] = state
        when {
            old == state -> Unit
            state == VoiceState.ASKING -> haptics.asking()
            // pi finished its work and is answering or listening again.
            old == VoiceState.WORKING && (state == VoiceState.SPEAKING || state == VoiceState.LISTENING) -> haptics.done()
            state == VoiceState.OFFLINE -> haptics.failed()
        }
    }
}
