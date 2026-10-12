package dev.pi_mobile.app.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.pi_mobile.app.app.LaunchRequest
import dev.pi_mobile.app.R
import dev.pi_mobile.app.core.PushContent

/**
 * Posting what [PushContent.shown] decided. Two channels so the user can tune them apart: `asks` (pi
 * needs an answer: high importance, heads-up) and `activity` (pi finished: default). Notifications group
 * per session (`machine:agent`) under a summary, as iOS threads them.
 *
 * Taps open MainActivity (through its non-exported alias, LaunchRequest) with the extras below; the shell calls `PiNative.focus(machine, agent)`, and
 * with [EXTRA_VOICE] starts voice mode on that session (BRIDGE.md `voice.start` with [EXTRA_ENTRY]).
 */
object Notifications {
    const val CHANNEL_ASKS = "asks"
    const val CHANNEL_ACTIVITY = "activity"

    /** The sending computer's hub machine id (what `PiNative.focus` takes). */
    const val EXTRA_MACHINE = "machine"
    /** The session id. */
    const val EXTRA_AGENT = "agent"
    /** This phone's machines-list entry id that opened the payload (BRIDGE.md `voice.start` `machine`). */
    const val EXTRA_ENTRY = "entry"
    /** true: "Answer by voice" was tapped. */
    const val EXTRA_VOICE = "voice"

    /** The tag for notifications nothing could open (no session to group them by). */
    private const val GENERIC_TAG = "pi"
    private const val SUMMARY_ID = 0
    private const val ACCENT = 0xFF5B93F5.toInt()
    /** Keeps the voice action's request code apart from every content request code. */
    private const val VOICE_BIT = 0x40000000

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_ASKS, context.getString(R.string.push_channel_asks), NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = context.getString(R.string.push_channel_asks_description) },
                NotificationChannel(CHANNEL_ACTIVITY, context.getString(R.string.push_channel_activity), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = context.getString(R.string.push_channel_activity_description) },
            ),
        )
    }

    /** A positive id below [VOICE_BIT], stable per FCM message so a redelivered one replaces itself. */
    fun idFor(messageId: String?): Int = ((messageId ?: System.nanoTime().toString()).hashCode() and (VOICE_BIT - 1)).coerceAtLeast(1)

    /**
     * The notification for [shown]. Only [PushContent] decides the text: when the payload didn't open it is
     * the generic "pi" / "New activity", with no session and no actions. On the lock screen it shows the
     * generic text unless the user allows sensitive content.
     */
    fun build(context: Context, shown: PushContent.Shown, id: Int): Notification {
        val channel = if (shown.asks) CHANNEL_ASKS else CHANNEL_ACTIVITY
        val b = base(context, channel, shown.asks)
            .setContentTitle(shown.title)
            .setContentText(shown.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(shown.body))
            .setContentIntent(open(context, shown, id, voice = false))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                base(context, channel, shown.asks).setContentTitle(PushContent.GENERIC_TITLE).setContentText(PushContent.GENERIC_BODY).build(),
            )
        shown.group?.let { b.setGroup(it) }
        if (shown.asks) {
            b.addAction(R.drawable.ic_push_voice, context.getString(R.string.push_answer_by_voice), open(context, shown, id, voice = true))
        }
        return b.build()
    }

    /** The group's summary: collapses one session's notifications; only the children alert. */
    fun summary(context: Context, shown: PushContent.Shown, id: Int): Notification? {
        val group = shown.group ?: return null
        return base(context, if (shown.asks) CHANNEL_ASKS else CHANNEL_ACTIVITY, shown.asks)
            .setContentTitle(shown.title)
            .setContentText(shown.body)
            .setContentIntent(open(context, shown, id, voice = false))
            .setGroup(group)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
    }

    /** Posts [shown] with its group summary; nothing when the user doesn't allow notifications. */
    fun post(context: Context, shown: PushContent.Shown, id: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        createChannels(context)
        val nm = NotificationManagerCompat.from(context)
        val tag = shown.group ?: GENERIC_TAG
        nm.notify(tag, id, build(context, shown, id))
        summary(context, shown, id)?.let { nm.notify(tag, SUMMARY_ID, it) }
    }

    private fun base(context: Context, channel: String, asks: Boolean) = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_stat_pi)
        .setColor(ACCENT)
        .setAutoCancel(true)
        .setPriority(if (asks) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)

    /**
     * Opens the app on the session. Each notification gets its own request code: PendingIntents that differ
     * only in extras would otherwise share (and overwrite) one another.
     */
    private fun open(context: Context, shown: PushContent.Shown, id: Int, voice: Boolean): PendingIntent {
        // The non-exported alias: only intents through it may name a session (LaunchRequest).
        val intent = Intent().setClassName(context, LaunchRequest.NOTIFICATION_ALIAS)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        shown.opened?.takeIf { it.agent.isNotEmpty() }?.let { o ->
            intent.putExtra(EXTRA_MACHINE, o.machine).putExtra(EXTRA_AGENT, o.agent).putExtra(EXTRA_ENTRY, o.entry)
            if (voice) intent.putExtra(EXTRA_VOICE, true)
        }
        val code = if (voice) id or VOICE_BIT else id
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
