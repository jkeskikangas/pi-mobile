package dev.pi_mobile.app.push

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.core.net.toUri
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.jsonOf
import dev.pi_mobile.app.core.obj
import kotlinx.serialization.json.JsonElement

/**
 * Personal build: the web menu's Notifications row (BRIDGE.md `push.status`, `push.enable`) backed by
 * [WatchService] instead of the FCM relay. Turning it on asks for the notification permission, starts the
 * service and asks to be exempt from battery optimization, without which Doze would cut the connection.
 */
class LiveNotifications(
    private val context: Context,
    private val permission: NotificationPermission,
    private val machines: () -> List<Machine>,
) : PushController {
    private val prefs = Prefs(context)

    /** At launch: keeps the service running while notifications are on. */
    fun start() {
        if (prefs.notificationsOn && permission.state() == "granted") WatchService.start(context)
    }

    override suspend fun status(): JsonElement {
        val p = permission.state()
        val on = prefs.notificationsOn && p == "granted"
        val now = WatchService.computers.value
        val computers = if (!on) emptyList() else machines().map { m ->
            val why = if (m.id in now) now[m.id] else "is connecting"
            jsonOf(mapOf("machine" to m.id, "notify" to (why == null)) + (why?.let { mapOf("why" to it) } ?: emptyMap()))
        }
        return obj("on" to on, "permission" to p, "available" to true, "computers" to computers)
    }

    override suspend fun enable(on: Boolean): JsonElement {
        if (!on) {
            prefs.notificationsOn = false
            WatchService.stop(context)
            return status()
        }
        if (machines().isEmpty()) throw Exception("Pair a computer first.")
        if (!permission.request()) throw Exception("Notifications are off for pi. Turn them on in Settings.")
        prefs.notificationsOn = true
        WatchService.start(context)
        askBatteryExemption()
        return status()
    }

    /** The system dialog "Let app always run in background?"; nothing when already exempt. */
    @SuppressLint("BatteryLife")
    private fun askBatteryExemption() {
        val pm = context.getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(context.packageName)) return
        try {
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:${context.packageName}".toUri())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: RuntimeException) {
            // No such screen on this phone: notifications still work while it isn't dozing.
        }
    }
}

/** Starts [WatchService] after a reboot or an app update while notifications are on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED ->
                if (Prefs(context).notificationsOn) WatchService.start(context)
        }
    }
}
