package dev.pi_mobile.app.voice

import android.app.Notification
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The ongoing voice notification's content per state. Port of native/ios/PiTests/VoiceActivityTests.swift. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VoiceNotificationTest {
    private val t0 = 1_000_000L
    private fun make(state: VoiceState, label: String = "", question: String? = null, muted: Boolean = false, session: String = "pi", machine: String? = null) =
        VoiceNotificationContent.make(state, label, question, muted, t0, session, machine)

    @Test fun questionOnlyWhileAsking() {
        assertEquals("Run it?", make(VoiceState.ASKING, "pi needs you", " Run it? ").question)
        assertNull(make(VoiceState.WORKING, "pi is on it", "Run it?").question)
        assertNull(make(VoiceState.ASKING, "pi needs you", "  ").question)
    }

    @Test fun labels() {
        assertEquals("pi is speaking", make(VoiceState.SPEAKING).label)
        assertEquals("Listening · mic off", make(VoiceState.LISTENING, "Listening", muted = true).label)
        assertEquals("Mic off", make(VoiceState.PAUSED, "Mic off", muted = true).label)
        assertEquals("Offline", make(VoiceState.OFFLINE).label)
        assertEquals(t0, make(VoiceState.WORKING, "pi is on it").startedMs)
    }

    @Test fun longTextIsClipped() {
        val huge = "Ä😀 ".repeat(5000)
        val s = make(VoiceState.ASKING, huge, huge, muted = true, session = huge, machine = huge)
        assertEquals(60, s.label.codePointCount(0, s.label.length))
        assertEquals(80, s.sessionName.codePointCount(0, s.sessionName.length))
        assertEquals(40, s.machine!!.codePointCount(0, s.machine!!.length))
        assertTrue(s.question!!.endsWith("…"))
        assertEquals("Run it?", make(VoiceState.ASKING, question = "Run it?").question)
    }

    @Test fun identityIsContent() {
        val s = make(VoiceState.WORKING, session = " ", machine = "studio")
        assertEquals("pi · studio", s.title)
        assertNotEquals(s, make(VoiceState.WORKING, session = "web", machine = "studio"))
    }

    @Test fun engineSessionFlowsIntoContent() {
        val ui = VoiceUiState(isOpen = true, state = VoiceState.LISTENING, sessionName = "api", machineName = "box")
        assertEquals("api · box", VoiceNotificationContent.of(ui, t0).title)
        val fresh = VoiceNotificationContent.of(VoiceUiState(), t0)
        assertEquals(VoiceState.CONNECTING, fresh.state)
        assertEquals("Connecting…", fresh.label)
        assertEquals(false, fresh.muted)
    }

    @Test fun paletteFollowsState() {
        val asking = make(VoiceState.ASKING).palette
        val listening = make(VoiceState.LISTENING).palette
        val muted = make(VoiceState.LISTENING, muted = true).palette
        val off = make(VoiceState.OFFLINE).palette
        assertNotEquals(asking.first, listening.first)
        assertEquals(muted.first, off.first)
    }

    @Test fun notificationShowsStateQuestionAndActions() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        VoiceNotification.createChannel(context)
        val asking = VoiceNotification.build(context, make(VoiceState.ASKING, "pi needs you", "Deploy to production?", session = "api", machine = "box"))
        assertEquals("pi needs you", asking.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Deploy to production?", asking.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals("api · box", asking.extras.getCharSequence(Notification.EXTRA_SUB_TEXT).toString())
        assertEquals(listOf("Mute", "End"), asking.actions.map { it.title.toString() })
        assertTrue(asking.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(t0, asking.`when`)
        assertTrue(asking.extras.getBoolean(Notification.EXTRA_SHOW_CHRONOMETER))
        assertNotNull(asking.contentIntent)

        val muted = VoiceNotification.build(context, make(VoiceState.PAUSED, "Mic off", muted = true, session = "api"))
        assertEquals("Mic off", muted.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("api", muted.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(listOf("Unmute", "End"), muted.actions.map { it.title.toString() })
    }
}
