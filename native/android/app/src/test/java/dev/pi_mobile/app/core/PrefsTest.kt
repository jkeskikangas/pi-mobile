package dev.pi_mobile.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrefsTest {
    private val prefs = Prefs(ApplicationProvider.getApplicationContext<Context>())

    @Test fun voicePrefsOnlyTakeTheBridgeKeys() {
        prefs.setVoice("pi-mobile-voice-persona", "cedar")
        prefs.setVoice("pi-mobile-voice-uses", "3")
        prefs.setVoice("something-else", "x")
        assertEquals(mapOf("pi-mobile-voice-persona" to "cedar", "pi-mobile-voice-uses" to "3"), prefs.voicePrefs)
        assertNull(prefs.voice("something-else"))
        prefs.setVoice("pi-mobile-voice-uses", null)
        assertEquals(setOf("pi-mobile-voice-persona"), prefs.voicePrefs.keys)
    }

    @Test fun lastFocusConsentAndPush() {
        assertNull(prefs.lastFocus)
        prefs.lastFocus = Prefs.Focus("a1", "e-mac", "api")
        assertEquals(Prefs.Focus("a1", "e-mac", "api"), Prefs(ApplicationProvider.getApplicationContext<Context>()).lastFocus)
        assertNull(prefs.aiConsent)
        prefs.aiConsent = 2
        assertEquals(2, prefs.aiConsent)
        prefs.aiConsent = null
        assertNull(prefs.aiConsent)
        prefs.notificationsOn = true
        assertEquals(true, prefs.notificationsOn)
    }

    @Test fun relayCapBelongsToItsToken() {
        prefs.pushToken = "t1"
        prefs.relayCap = "cap1"
        assertEquals("cap1", prefs.relayCap)
        prefs.pushToken = "t2"
        assertNull("a new token needs a new capability", prefs.relayCap)
        prefs.pushRegistered = setOf("e|d|t2")
        assertEquals(setOf("e|d|t2"), prefs.pushRegistered)
        prefs.relayPausedUntilMs = 5
        assertEquals(5L, prefs.relayPausedUntilMs)
    }
}
