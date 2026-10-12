package dev.pi_mobile.app.voice

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps voice mode alive with the screen off (plan A8): a microphone foreground service for as long as the
 * engine is open, with the ongoing [VoiceNotification] (the Live Activity counterpart) updated on every
 * change it shows. Started by [VoiceHost] from visible UI, a notification or the tile; stops itself when the
 * engine closes. Its notification's Mute and End come back here as [ACTION_MUTE] / [ACTION_END].
 */
class VoiceService : Service() {
    private val scope = MainScope()
    private var watch: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var startedMs = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        VoiceNotification.createChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val host = VoiceHost.sharedOrNull
        val running = host?.engine?.takeIf { it.isOpen }
        when (intent?.action) {
            // A Mute or End left on a notification of a voice mode that is gone: nothing to act on, nothing to keep.
            ACTION_MUTE -> running?.toggleMute() ?: return stop()
            ACTION_END -> running?.stop() ?: return stop()
            else -> {
                if (watch == null) startedMs = System.currentTimeMillis()
                // Within seconds of startForegroundService, and while the app is visible (microphone FGS rules).
                val ui = host?.engine?.ui?.value ?: VoiceUiState()
                try {
                    ServiceCompat.startForeground(
                        this, VoiceNotification.ID, VoiceNotification.build(this, VoiceNotificationContent.of(ui, startedMs)),
                        if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
                    )
                } catch (_: RuntimeException) {
                    // Android 14+ refuses a microphone service unless pi is in front (SecurityException), 12+ a
                    // late start (ForegroundServiceStartNotAllowedException): no voice mode without it.
                    host?.engine?.stop()
                    Toast.makeText(this, VoiceHost.OPEN_PI, Toast.LENGTH_LONG).show()
                    return stop()
                }
                // Started for a voice mode that is already gone (a restart without the app): nothing to keep alive.
                if (host == null) return stop()
                run(host)
            }
        }
        return START_NOT_STICKY
    }

    private fun run(host: VoiceHost) {
        if (watch != null) return
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pi:voice").apply {
            setReferenceCounted(false)
            acquire(WAKE_LOCK_MAX_MS)
        }
        var wasOpen = false
        // A voice mode that never opened (its start failed after the service was asked for) keeps nothing alive.
        scope.launch {
            delay(OPEN_TIMEOUT_MS)
            if (!wasOpen) stop()
        }
        watch = scope.launch {
            host.engine.ui
                .map { it.isOpen to VoiceNotificationContent.of(it, startedMs) }
                .distinctUntilChanged()
                .collect { (open, content) ->
                    if (!open) {
                        if (wasOpen) stop()
                        return@collect
                    }
                    wasOpen = true
                    post(content)
                }
        }
    }

    /** Posting needs POST_NOTIFICATIONS on 13+; without it the service still runs (the system shows it in the task manager). */
    private fun post(content: VoiceNotificationContent) {
        val nm = NotificationManagerCompat.from(this)
        if (nm.areNotificationsEnabled()) {
            @Suppress("MissingPermission")
            nm.notify(VoiceNotification.ID, VoiceNotification.build(this, content))
        }
    }

    private fun stop(): Int {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        // The phone-wide mic mute is pi's only while voice mode runs.
        AudioSessionController.clearStaleMute(this)
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    companion object {
        const val ACTION_RUN = "dev.pi_mobile.app.voice.RUN"
        const val ACTION_MUTE = "dev.pi_mobile.app.voice.MUTE"
        const val ACTION_END = "dev.pi_mobile.app.voice.END"
        /** A safety net: a voice mode that somehow never ends doesn't hold the CPU forever. */
        private const val WAKE_LOCK_MAX_MS = 4 * 60 * 60 * 1000L
        private const val OPEN_TIMEOUT_MS = 10_000L

        fun intent(context: Context, action: String): Intent = Intent(context, VoiceService::class.java).setAction(action)
    }
}
