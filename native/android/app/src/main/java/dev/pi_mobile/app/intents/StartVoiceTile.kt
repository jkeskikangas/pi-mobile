package dev.pi_mobile.app.intents

import android.app.PendingIntent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dev.pi_mobile.app.R
import dev.pi_mobile.app.voice.VoiceHost
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Quick Settings "Talk to pi" (plan A11; the Control widget's counterpart). It opens the app into voice mode and
 * collapses the shade: the app starts voice once it is in front (MainActivity's launch request), the only time
 * Android 14+ lets a microphone service start [verify on 14/15/16], and where consent and the microphone can be
 * asked. With voice mode running it just brings the voice screen up. Lit while voice mode runs.
 */
class StartVoiceTile : TileService() {
    private val scope = MainScope()
    private var watch: Job? = null

    override fun onStartListening() {
        val tile = qsTile ?: return
        tile.label = getString(R.string.voice_tile_label)
        tile.icon = Icon.createWithResource(this, R.drawable.voice_notification)
        val host = VoiceHost.sharedOrNull ?: return show(tile, false)
        watch?.cancel()
        watch = scope.launch { host.running.collect { show(tile, it != null) } }
    }

    override fun onStopListening() {
        watch?.cancel()
        watch = null
    }

    private fun show(tile: Tile, running: Boolean) {
        tile.state = if (running) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.updateTile()
    }

    override fun onClick() {
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
