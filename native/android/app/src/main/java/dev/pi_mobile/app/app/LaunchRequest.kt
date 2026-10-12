package dev.pi_mobile.app.app

import android.content.Intent
import dev.pi_mobile.app.push.Notifications
import dev.pi_mobile.app.voice.VoiceHost

/**
 * What an intent asks the app to do on arrival. MainActivity is exported (the launcher, the shortcut), so any app
 * can send it extras: a session (agent, entry, machine) is honoured only from the app's own notifications, which
 * reach it through the non-exported alias [NOTIFICATION_ALIAS] (no other app can start that component). From
 * anywhere else `voice` still opens voice mode, as the public shortcut and tile do, but on the session voice mode
 * picks itself (the one that needs you, else the last), like asking Siri on iOS.
 */
sealed interface LaunchRequest {
    /** A notification tap: open that session in the page (BRIDGE.md `focus`). */
    data class Focus(val machine: String, val agent: String) : LaunchRequest

    /**
     * Voice mode. From "Answer by voice" (as iOS PushCenter.opened): the page opens the session ([focus]) and voice
     * mode starts on it only when the notification names its machines-list [entry]; the notification is dismissed.
     * From the public shortcut or tile: all null, voice mode picks the session.
     */
    data class Voice(
        val agent: String? = null,
        val entry: String? = null,
        val machine: String = "",
        val notification: Pair<String, Int>? = null,
    ) : LaunchRequest {
        val focus: Focus? get() = agent?.let { Focus(machine, it) }

        /** A named session needs its entry; without a session voice mode picks one. */
        val starts: Boolean get() = agent == null || entry != null

        /** "Voice mode didn't start: …" for a session the user asked to answer, the bare sentence otherwise. */
        fun failure(message: String?): String = if (agent != null) "Voice mode didn't start: $message" else message ?: ""
    }

    companion object {
        /** The `<activity-alias>` of MainActivity the app's notifications target (AndroidManifest.xml). */
        const val NOTIFICATION_ALIAS = "dev.pi_mobile.app.app.NotificationOpen"

        fun of(intent: Intent): LaunchRequest? {
            val trusted = intent.component?.className == NOTIFICATION_ALIAS
            val agent = intent.getStringExtra(Notifications.EXTRA_AGENT)?.takeIf { trusted && it.isNotEmpty() }
            // The shortcut's XML extra arrives as the string "true".
            val voice = intent.getBooleanExtra(VoiceHost.EXTRA_VOICE, false) || intent.getStringExtra(VoiceHost.EXTRA_VOICE) == "true"
            return when {
                voice -> if (agent == null) Voice() else Voice(
                    agent,
                    intent.getStringExtra(Notifications.EXTRA_ENTRY)?.takeIf { it.isNotEmpty() },
                    intent.getStringExtra(Notifications.EXTRA_MACHINE) ?: "",
                    intent.getStringExtra(Notifications.EXTRA_TAG)?.let { it to intent.getIntExtra(Notifications.EXTRA_ID, 0) },
                )
                agent != null -> Focus(intent.getStringExtra(Notifications.EXTRA_MACHINE) ?: "", agent)
                else -> null
            }
        }
    }
}
