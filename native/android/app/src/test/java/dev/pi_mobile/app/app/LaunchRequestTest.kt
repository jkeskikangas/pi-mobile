package dev.pi_mobile.app.app

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.consent.AIConsent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** Which intents may name a session, and that a cold voice start can ask for consent. */
@RunWith(RobolectricTestRunner::class)
class LaunchRequestTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun public() = Intent(context, MainActivity::class.java)
    private fun ours() = Intent().setClassName(context, LaunchRequest.NOTIFICATION_ALIAS)
    private fun Intent.session() = putExtra("agent", "a1").putExtra("entry", "e-mac").putExtra("machine", "m-mac")

    @Test fun onlyTheAppsOwnNotificationsNameASession() {
        assertEquals(LaunchRequest.Voice("a1", "e-mac", "m-mac"), LaunchRequest.of(ours().session().putExtra("voice", true)))
        assertEquals(LaunchRequest.Focus("m-mac", "a1"), LaunchRequest.of(ours().session()))
        // Another app (or the public shortcut) can open voice mode, but voice mode picks the session.
        assertEquals(LaunchRequest.Voice(), LaunchRequest.of(public().session().putExtra("voice", true)))
        assertNull("no focus from outside", LaunchRequest.of(public().session()))
        assertNull(LaunchRequest.of(public()))
    }

    @Test fun theShortcutsStringExtraOpensVoice() {
        assertEquals(LaunchRequest.Voice(), LaunchRequest.of(public().putExtra("voice", "true")))
        assertNull(LaunchRequest.of(public().putExtra("voice", "no")))
    }

    /** As iOS PushCenter.opened: open the session, start voice only with its entry, dismiss the notification. */
    @Test fun answerByVoiceOpensTheSessionThenVoice() {
        val answer = LaunchRequest.of(ours().session().putExtra("voice", true).putExtra("notification-tag", "m-mac:a1").putExtra("notification-id", 7))
            as LaunchRequest.Voice
        assertEquals(LaunchRequest.Focus("m-mac", "a1"), answer.focus)
        assertEquals(true, answer.starts)
        assertEquals("m-mac:a1" to 7, answer.notification)
        assertEquals("Voice mode didn't start: No pi session is reachable.", answer.failure("No pi session is reachable."))

        val noEntry = LaunchRequest.of(ours().putExtra("agent", "a1").putExtra("voice", true)) as LaunchRequest.Voice
        assertEquals("only the page opens the session", false, noEntry.starts)
        assertEquals(LaunchRequest.Focus("", "a1"), noEntry.focus)

        val picked = LaunchRequest.Voice()
        assertEquals(true, picked.starts)
        assertNull(picked.focus)
        assertEquals("Microphone access is off.", picked.failure("Microphone access is off."))
    }

    /** Cold start from the shortcut, the tile or "Answer by voice": the consent sheet comes up instead of NeedsApp. */
    @Test fun aColdVoiceStartAsksForConsent() {
        val app = ApplicationProvider.getApplicationContext<PiApplication>()
        ActivityScenario.launch<MainActivity>(public().putExtra("voice", true)).use {
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AIConsent.Purpose.VOICE, app.consentPrompter.pending?.purpose)
            app.consentPrompter.pending?.choose?.invoke(false)
        }
    }
}
