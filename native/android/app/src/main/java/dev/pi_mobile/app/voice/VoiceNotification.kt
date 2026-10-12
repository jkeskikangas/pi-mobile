package dev.pi_mobile.app.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import androidx.core.app.NotificationCompat
import dev.pi_mobile.app.R
import java.util.Locale

/**
 * What the ongoing voice notification shows: the Live Activity's content state (Shared/VoiceActivityAttributes.swift),
 * mapped from the engine and unit tested. `label` is the engine's state word; speaking has none on the voice
 * screen (the captions say it), so the notification names it.
 */
data class VoiceNotificationContent(
    val state: VoiceState,
    val label: String,
    /** pi's open question, only while asking. */
    val question: String?,
    val muted: Boolean,
    /** When voice mode opened (epoch ms): the notification's chronometer counts from it without updates. */
    val startedMs: Long,
    val sessionName: String,
    /** Shown only while there are several machines. */
    val machine: String?,
) {
    val title: String get() = machine?.let { "$sessionName · $it" } ?: sessionName

    /** The orb's palette (`web/app.css` `.voice[data-state]`, dark tokens): its two stops, ARGB. */
    val palette: Pair<Int, Int>
        get() = when {
            muted -> GREY
            state == VoiceState.LISTENING || state == VoiceState.HEARING -> 0xff6e9bff.toInt() to 0xff57d0f0.toInt()
            state == VoiceState.THINKING -> 0xff6e9bff.toInt() to 0xffb39bff.toInt()
            state == VoiceState.WORKING -> 0xffb39bff.toInt() to 0xffe58cf9.toInt()
            state == VoiceState.SPEAKING -> 0xff4fd1c5.toInt() to 0xff7ee8b5.toInt()
            state == VoiceState.ASKING -> 0xfff5b84a.toInt() to 0xfffb923c.toInt()
            else -> GREY
        }

    companion object {
        private val GREY = 0xff7d8189.toInt() to 0xff9a9da4.toInt()

        fun make(
            state: VoiceState, label: String, question: String?, muted: Boolean, startedMs: Long,
            sessionName: String = "pi", machine: String? = null,
        ): VoiceNotificationContent {
            val q = question?.trim()?.takeIf { state == VoiceState.ASKING && it.isNotEmpty() }
            var l = label.ifEmpty {
                if (state == VoiceState.SPEAKING) "pi is speaking" else state.name.lowercase().replaceFirstChar { it.titlecase(Locale.ROOT) }
            }
            if (muted && state != VoiceState.PAUSED) l += " · mic off"
            val name = sessionName.trim().ifEmpty { "pi" }
            return VoiceNotificationContent(state, clip(l, 60), q?.let { clip(it, 300) }, muted, startedMs, clip(name, 80), machine?.let { clip(it, 40) })
        }

        /** The engine's state as notification content (`VoiceActivityController.content`). */
        fun of(ui: VoiceUiState, startedMs: Long) = make(ui.state, ui.label, ui.question?.title, ui.muted, startedMs, ui.sessionName, ui.machineName)

        fun clip(s: String, n: Int): String {
            val count = s.codePointCount(0, s.length)
            if (count <= n) return s
            return s.substring(0, s.offsetByCodePoints(0, maxOf(0, n - 1))) + "…"
        }
    }
}

/**
 * The ongoing voice notification (plan A8): the Live Activity counterpart. State colour, label, question,
 * elapsed time, session (and machine when several); Mute/Unmute and End; a tap opens the voice screen.
 * Promoted to a Live Update on Android 16 where the system allows it.
 */
object VoiceNotification {
    const val CHANNEL = "voice"
    const val ID = 4127

    fun createChannel(context: Context) {
        val channel = NotificationChannel(CHANNEL, context.getString(R.string.voice_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            description = context.getString(R.string.voice_channel_description)
            setShowBadge(false)
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun build(context: Context, c: VoiceNotificationContent): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(context, 0, VoiceHost.openIntent(context), flags)
        val mute = PendingIntent.getService(context, 1, VoiceService.intent(context, VoiceService.ACTION_MUTE), flags)
        val end = PendingIntent.getService(context, 2, VoiceService.intent(context, VoiceService.ACTION_END), flags)
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.voice_notification)
            .setColor(c.palette.first)
            .setContentTitle(c.label)
            .setContentText(c.question ?: c.title)
            .setSubText(c.title.takeIf { c.question != null })
            .setStyle(c.question?.let { NotificationCompat.BigTextStyle().bigText(it) })
            .setWhen(c.startedMs)
            .setUsesChronometer(true)
            .setShowWhen(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setRequestPromotedOngoing(true)
            .setShortCriticalText(if (c.question != null) "Needs you" else if (c.muted) "Mic off" else c.label)
            .setContentIntent(open)
            .addAction(0, context.getString(if (c.muted) R.string.voice_unmute else R.string.voice_mute), mute)
            .addAction(0, context.getString(R.string.voice_end), end)
            .build()
    }
}
