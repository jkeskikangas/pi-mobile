package dev.pi_mobile.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.pi_mobile.app.app.PushCenter
import dev.pi_mobile.app.core.KeystoreMachineStore
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.PushContent

/**
 * FCM's entry point. Messages are data-only (relay/src/fcm.ts: `{ sealed, urgent? }`), so this runs for
 * every push, foreground or not, and the text is opened here with the keys only this phone has.
 */
class PiMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        // Idempotent; covers a process started for a push before anything else initialised Firebase.
        FirebaseSetup.init(this)
        super.onCreate()
    }

    override fun onNewToken(token: String) {
        // PiApplication holds the one PushCenter; computers holding a cap for the old token get a new one.
        (application as? PushCenter.Host)?.pushCenter?.tokenChanged(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Off means off now, even while a computer that missed the off still sends.
        if (!Prefs(this).notificationsOn) return
        val shown = PushContent.shown(message.data, KeystoreMachineStore(this).load())
        Notifications.post(this, shown, Notifications.idFor(message.messageId))
    }
}
