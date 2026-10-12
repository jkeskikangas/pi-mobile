package dev.pi_mobile.app.ui

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect

/**
 * Android's "Remove animations" (animator duration scale 0), the `prefers-reduced-motion` counterpart:
 * loops stop and the orb becomes a still disc (design-principles.md §5). Re-read when the app comes back,
 * since it is changed in system Settings.
 */
@Composable
fun rememberReducedMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    fun read() = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    var reduced by remember(resolver) { mutableStateOf(read()) }
    LifecycleResumeEffect(resolver) {
        reduced = read()
        onPauseOrDispose {}
    }
    return reduced
}
