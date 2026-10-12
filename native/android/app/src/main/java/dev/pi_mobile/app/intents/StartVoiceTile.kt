package dev.pi_mobile.app.intents

import android.app.PendingIntent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dev.pi_mobile.app.R
import dev.pi_mobile.app.voice.VoiceHost
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Quick Settings "Talk to pi" (plan A11; the Control widget's counterpart). With the app on screen it starts
 * voice mode directly; otherwise it opens the app into voice mode, because a microphone foreground service
 * can't start from the background on Android 14+ [verify on 14/15/16]. Lit while voice mode runs.
 */
class StartVoiceTile : TileService() {
    private val scope = MainScope()

    override fun onStartListening() {
        val tile = qsTile ?: return
        tile.label = getString(R.string.voice_tile_label)
        tile.icon = Icon.createWithResource(this, R.drawable.voice_notification)
        tile.state = if (VoiceHost.sharedOrNull?.running?.value != null) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.updateTile()
    }

    override fun onClick() {
        val host = VoiceHost.sharedOrNull
        if (host == null || host.running.value != null || !VoiceHost.appVisible()) return openApp()
        scope.launch {
            // Consent, the microphone permission or no session: the app asks and explains.
            try {
                host.start()
            } catch (_: Exception) {
                openApp()
            }
        }
    }

    private fun openApp() {
        val intent = VoiceHost.openIntent(this)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
