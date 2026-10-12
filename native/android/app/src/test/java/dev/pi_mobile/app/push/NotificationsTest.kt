package dev.pi_mobile.app.push

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.MainActivity
import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.Envelope
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.PushContent
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.File

/**
 * What the phone shows for a relay push: the opened text grouped per session, "Answer by voice" on asks,
 * taps that open the session, and never plaintext when the payload doesn't open. The Android side of
 * PiTests/PushTests.swift (the rewrite itself is covered by core/PushContentTest).
 */
@RunWith(RobolectricTestRunner::class)
class NotificationsTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val k = parseJson(File(System.getProperty("pi.repo"), "native/fixtures/crypto-vectors.json").readText())["key"].string!!
    private val machines = listOf(
        Machine(id = "e-other", machine = "m-other", name = "box", origin = "https://box.ts.net", d = "d2", k = Base64Url.encode(ByteArray(32) { 9 }), primary = true),
        Machine(id = "e-mac", machine = "m-mac", name = "mac", origin = "https://mac.ts.net", d = "d1", k = k),
    )

    private fun shown(urgent: Boolean, agent: String = "a1"): PushContent.Shown {
        val sealed = Envelope.seal(Base64Url.decode(k)!!, obj("title" to "pi-mobile asks", "body" to "Run the migration?", "agent" to agent, "machine" to "m-mac"))
        return PushContent.shown(if (urgent) mapOf("sealed" to sealed, "urgent" to "1") else mapOf("sealed" to sealed), machines)
    }

    private fun Notification.text(key: String) = extras.getCharSequence(key)?.toString()
    private fun Notification.opens() = shadowOf(contentIntent).savedIntent

    @Test fun asksShowTheOpenedTextWithAnswerByVoice() {
        val n = Notifications.build(app, shown(urgent = true), 7)
        assertEquals(Notifications.CHANNEL_ASKS, n.channelId)
        assertEquals("pi-mobile asks", n.text(NotificationCompat.EXTRA_TITLE))
        assertEquals("Run the migration?", n.text(NotificationCompat.EXTRA_TEXT))
        assertEquals("m-mac:a1", n.group)
        assertEquals("pi", n.publicVersion.text(NotificationCompat.EXTRA_TITLE))
        assertEquals("New activity", n.publicVersion.text(NotificationCompat.EXTRA_TEXT))
        val open = n.opens()
        assertEquals(MainActivity::class.java.name, open.component?.className)
        assertEquals("m-mac", open.getStringExtra(Notifications.EXTRA_MACHINE))
        assertEquals("a1", open.getStringExtra(Notifications.EXTRA_AGENT))
        assertEquals("e-mac", open.getStringExtra(Notifications.EXTRA_ENTRY))
        assertFalse(open.hasExtra(Notifications.EXTRA_VOICE))
        assertEquals(1, n.actions.size)
        assertEquals("Answer by voice", n.actions[0].title.toString())
        val voice = shadowOf(n.actions[0].actionIntent).savedIntent
        assertTrue(voice.getBooleanExtra(Notifications.EXTRA_VOICE, false))
        assertEquals("a1", voice.getStringExtra(Notifications.EXTRA_AGENT))
        assertEquals("e-mac", voice.getStringExtra(Notifications.EXTRA_ENTRY))
    }

    @Test fun notUrgentHasNoVoiceAction() {
        val n = Notifications.build(app, shown(urgent = false), 7)
        assertEquals(Notifications.CHANNEL_ACTIVITY, n.channelId)
        assertNull(n.actions)
        assertEquals("a1", n.opens().getStringExtra(Notifications.EXTRA_AGENT))
    }

    @Test fun keepsGenericTextWhenNoKeyOpensIt() {
        val n = Notifications.build(app, PushContent.shown(mapOf("sealed" to "nope", "urgent" to "1"), machines), 7)
        assertEquals("pi", n.text(NotificationCompat.EXTRA_TITLE))
        assertEquals("New activity", n.text(NotificationCompat.EXTRA_TEXT))
        assertEquals(Notifications.CHANNEL_ACTIVITY, n.channelId)
        assertNull(n.group)
        assertNull(n.actions)
        assertNull("opens the app, no session", n.opens().extras)
    }

    @Test fun eachNotificationKeepsItsOwnTap() {
        val a = Notifications.build(app, shown(urgent = false, agent = "a1"), 1)
        val b = Notifications.build(app, shown(urgent = false, agent = "a2"), 2)
        assertEquals("a1", a.opens().getStringExtra(Notifications.EXTRA_AGENT))
        assertEquals("a2", b.opens().getStringExtra(Notifications.EXTRA_AGENT))
    }

    @Test fun postsGroupedUnderASummaryOnlyWhenAllowed() {
        val nm = app.getSystemService(NotificationManager::class.java)
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        Notifications.post(app, shown(urgent = true), 5)
        assertEquals(0, shadowOf(nm).allNotifications.size)
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        Notifications.post(app, shown(urgent = true), 5)
        Notifications.post(app, shown(urgent = true), 6)
        val posted = shadowOf(nm).allNotifications
        assertEquals("two children, one summary", 3, posted.size)
        assertTrue(posted.all { it.group == "m-mac:a1" })
        assertEquals(1, posted.count { it.flags and Notification.FLAG_GROUP_SUMMARY != 0 })
        assertEquals(NotificationManager.IMPORTANCE_HIGH, nm.getNotificationChannel(Notifications.CHANNEL_ASKS).importance)
        assertEquals("pi needs you", nm.getNotificationChannel(Notifications.CHANNEL_ASKS).name)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, nm.getNotificationChannel(Notifications.CHANNEL_ACTIVITY).importance)
        assertEquals("pi finished", nm.getNotificationChannel(Notifications.CHANNEL_ACTIVITY).name)
    }

    @Test fun idsAreStablePositiveAndClearOfTheVoiceBit() {
        assertEquals(Notifications.idFor("0:123%abc"), Notifications.idFor("0:123%abc"))
        for (s in listOf("a", "0:123%abc", "", null)) {
            val id = Notifications.idFor(s)
            assertTrue(id in 1 until 0x40000000)
        }
    }

    @Test fun firebaseNeedsAllFourValues() {
        assertTrue(FirebaseSetup.configured("p", "1:2:android:3", "key", "4"))
        assertFalse(FirebaseSetup.configured("p", "", "key", "4"))
    }
}
