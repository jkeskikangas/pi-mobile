package dev.pi_mobile.app.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dev.pi_mobile.app.R
import dev.pi_mobile.app.app.MainActivity
import dev.pi_mobile.app.app.PiApplication
import dev.pi_mobile.app.core.AttentionWatch
import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.EmptyObject
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.PushContent
import dev.pi_mobile.app.core.array
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.get
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Personal build: notifications without Firebase. A foreground service (hence its always-on notification, on
 * its own silent channel) keeps one event stream open to every paired computer, and [AttentionWatch] turns
 * the events into pi's real notifications on the existing `asks` and `activity` channels.
 *
 * Runs while notifications are on; restarted by the system (START_STICKY), at boot and after an update
 * ([BootReceiver]). Dependable in Doze only when pi is exempt from battery optimization
 * ([LiveNotifications.enable] asks for that).
 */
class WatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var machinesJob: Job? = null
    private val watches = HashMap<String, Job>()
    private var shownText: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as PiApplication
        if (!Prefs(this).notificationsOn) {
            stopSelf()
            return START_NOT_STICKY
        }
        createChannel(this)
        try {
            ServiceCompat.startForeground(
                this, ONGOING_ID, ongoing(text(app.model.machines.value)),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
            )
        } catch (_: RuntimeException) {
            // Refused from the background (no exemption): the next app start tries again.
            stopSelf()
            return START_NOT_STICKY
        }
        if (machinesJob == null) {
            machinesJob = scope.launch { app.model.machines.collect { sync(it) } }
            scope.launch { status.collect { refreshOngoing(app.model.machines.value) } }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        status.value = emptyMap()
        super.onDestroy()
    }

    /** One stream per computer; a re-paired computer (new device or address) gets a fresh one. */
    @Synchronized
    private fun sync(list: List<Machine>) {
        val wanted = list.associateBy { "${it.id}|${it.d}|${it.origin}" }
        for (key in watches.keys - wanted.keys) watches.remove(key)?.cancel()
        for ((key, m) in wanted) if (key !in watches) watches[key] = scope.launch { watch(m) }
        status.update { s -> s.filterKeys { id -> list.any { it.id == id } } }
        refreshOngoing(list)
    }

    private suspend fun watch(m: Machine) {
        val app = application as PiApplication
        val attention = AttentionWatch()
        while (scope.isActive) {
            val client = try {
                HubClient(m)
            } catch (e: HubError) {
                setStatus(m, e.message ?: "can't be reached with its stored address or key")
                return
            }
            try {
                client.updates().collect { u ->
                    when (u) {
                        is HubClient.Update.State -> setStatus(m, if (u.state == ConnectionState.ONLINE) null else UNREACHABLE)
                        is HubClient.Update.Event -> {
                            val ev = u.event
                            if (ev.type == "hello") {
                                if (ev.raw["resync"].bool != false) seed(client, attention)
                            } else {
                                for (a in attention.onEvent(ev, System.currentTimeMillis())) act(app, m, a)
                            }
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: HubError.Unauthorized) {
                setStatus(m, "removed this phone: pair it again")
                return
            } catch (_: Exception) {
                setStatus(m, UNREACHABLE)
            }
            delay(RETRY_MS)
        }
    }

    /** After a fresh connection: what is running now is known, not news. */
    private suspend fun seed(client: HubClient, attention: AttentionWatch) {
        val agents = try {
            client.rpc("hub", EmptyObject)["agents"].array
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        attention.seed(agents ?: emptyList(), System.currentTimeMillis())
    }

    private fun act(app: PiApplication, m: Machine, a: AttentionWatch.Action) {
        val machine = m.machine.ifEmpty { m.id }
        val group = "$machine:${a.agent}"
        val id = Notifications.idFor(a.key)
        when (a) {
            is AttentionWatch.Dismiss -> {
                val nm = getSystemService(NotificationManager::class.java)
                nm.cancel(group, id)
                // The session's summary (Notifications.post, id 0) goes with its last notification.
                val rest = nm.activeNotifications.filter { it.tag == group && it.id != id && it.id != SUMMARY_ID }
                if (rest.isEmpty()) nm.cancel(group, SUMMARY_ID)
            }
            is AttentionWatch.Alert -> {
                // pi is on screen: the page already shows it.
                if (app.inFront) return
                val opened = PushContent.Opened(a.title, a.body, a.agent, machine, m.id)
                Notifications.post(this, PushContent.Shown(a.title, a.body, opened, group, asks = a.urgent), id)
            }
        }
    }

    private fun setStatus(m: Machine, why: String?) {
        status.update { if (it.containsKey(m.id) && it[m.id] == why) it else it + (m.id to why) }
    }

    @Synchronized
    private fun refreshOngoing(list: List<Machine>) {
        val t = text(list)
        if (t == shownText) return
        shownText = t
        try {
            NotificationManagerCompat.from(this).notify(ONGOING_ID, ongoing(t))
        } catch (_: SecurityException) {
            // Notifications not allowed: the service runs on, the system hides its notification.
        }
    }

    private fun text(list: List<Machine>): String {
        val s = status.value
        val online = list.filter { it.id in s && s[it.id] == null }
        return when {
            list.isEmpty() -> "No computer paired"
            online.size == list.size && list.size == 1 -> "Connected to ${list[0].name}"
            online.size == list.size -> "Connected to ${list.size} computers"
            online.isEmpty() && list.size == 1 -> "Reconnecting to ${list[0].name}…"
            else -> "Connected to ${online.size} of ${list.size} computers"
        }
    }

    private fun ongoing(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_stat_pi)
            .setContentTitle(text)
            .setContentText(getString(R.string.watch_ongoing_text))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val CHANNEL_WATCH = "watch"
        private const val ONGOING_ID = 0x7a7c4
        private const val RETRY_MS = 30_000L
        /** Notifications.post's group summary id. */
        private const val SUMMARY_ID = 0
        private const val UNREACHABLE = "isn't reachable right now"

        /** Entry id → null while its stream is up, else why not (BRIDGE.md `push.status` `computers`). */
        private val status = MutableStateFlow<Map<String, String?>>(emptyMap())
        val computers: StateFlow<Map<String, String?>> get() = status

        fun createChannel(context: Context) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_WATCH, context.getString(R.string.watch_channel), NotificationManager.IMPORTANCE_MIN)
                    .apply {
                        description = context.getString(R.string.watch_channel_description)
                        setShowBadge(false)
                    },
            )
        }

        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, WatchService::class.java))
            } catch (_: RuntimeException) {
                // Not allowed from the background right now; the next app start or boot tries again.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, WatchService::class.java))
        }
    }
}
