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

    /** Voice mode: on [agent] of machines-list entry [entry] ("Answer by voice"), or both null (voice mode picks). */
    data class Voice(val agent: String?, val entry: String?) : LaunchRequest

    companion object {
        /** The `<activity-alias>` of MainActivity the app's notifications target (AndroidManifest.xml). */
        const val NOTIFICATION_ALIAS = "dev.pi_mobile.app.app.NotificationOpen"

        fun of(intent: Intent): LaunchRequest? {
            val trusted = intent.component?.className == NOTIFICATION_ALIAS
            val agent = intent.getStringExtra(Notifications.EXTRA_AGENT)?.takeIf { trusted && it.isNotEmpty() }
            // The shortcut's XML extra arrives as the string "true".
            val voice = intent.getBooleanExtra(VoiceHost.EXTRA_VOICE, false) || intent.getStringExtra(VoiceHost.EXTRA_VOICE) == "true"
            return when {
                voice -> Voice(agent, intent.getStringExtra(Notifications.EXTRA_ENTRY)?.takeIf { trusted && it.isNotEmpty() })
                agent != null -> Focus(intent.getStringExtra(Notifications.EXTRA_MACHINE) ?: "", agent)
                else -> null
            }
        }
    }
}
