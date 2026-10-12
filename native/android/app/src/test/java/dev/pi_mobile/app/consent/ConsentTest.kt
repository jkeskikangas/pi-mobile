package dev.pi_mobile.app.consent

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.consent.AIConsent.Purpose
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The third-party AI consent gate (port of ConsentTests.swift, the AIConsent part). */
@RunWith(RobolectricTestRunner::class)
class ConsentTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("pi-consent-tests", Context.MODE_PRIVATE)

    @Before fun clear() = prefs.edit().clear().commit().let {}

    private fun consent(answer: Boolean, canAsk: Boolean = true, asked: () -> Unit = {}) =
        AIConsent(prefs, ask = { asked(); answer }, canAsk = { canAsk })

    @Test fun allowIsStoredWithItsVersionAndAskedOnce() = runTest {
        var asks = 0
        val c = consent(answer = true) { asks++ }
        c.ensure(Purpose.VOICE)
        c.ensure(Purpose.DICTATION)
        assertEquals(1, asks)
        assertEquals(AIConsent.VERSION, prefs.getInt(AIConsent.KEY, 0))
        // An older version (fewer recipients) asks again.
        prefs.edit().putInt(AIConsent.KEY, AIConsent.VERSION - 1).commit()
        assertFalse(c.granted)
        c.ensure(Purpose.VOICE)
        assertEquals(2, asks)
    }

    @Test fun notNowAndBackgroundThrowAndStoreNothing() = runTest {
        try {
            consent(answer = false).ensure(Purpose.VOICE)
            fail()
        } catch (e: AIConsent.Declined) {
            // Word for word as BRIDGE.md documents the voice.start error.
            assertEquals("Voice mode needs your OK to send your voice. Try again to see the details.", e.message)
        }
        try {
            consent(answer = false).ensure(Purpose.DICTATION)
            fail()
        } catch (e: AIConsent.Declined) {
            assertEquals("Dictation needs your OK to send audio to your computer. Try again to see the details.", e.message)
        }
        var asked = false
        try {
            consent(answer = true, canAsk = false) { asked = true }.ensure(Purpose.VOICE)
            fail()
        } catch (_: AIConsent.NeedsApp) {
        }
        assertFalse("never asks while the app isn't on screen", asked)
        assertFalse(consent(answer = true).granted)
    }

    @Test fun revokeAsksAgain() = runTest {
        var asks = 0
        val c = consent(answer = true) { asks++ }
        c.ensure(Purpose.VOICE)
        c.revoke()
        assertFalse(c.granted)
        c.ensure(Purpose.VOICE)
        assertEquals(2, asks)
    }

    @Test fun concurrentCallersShareOneSheet() = runTest {
        val answer = CompletableDeferred<Boolean>()
        var asks = 0
        val c = AIConsent(prefs, ask = { asks++; answer.await() }, canAsk = { true })
        val voice = async { runCatching { c.ensure(Purpose.VOICE) } }
        val dictation = async { runCatching { c.ensure(Purpose.DICTATION) } }
        testScheduler.runCurrent()
        answer.complete(false)
        assertTrue(voice.await().exceptionOrNull() is AIConsent.Declined)
        assertTrue(dictation.await().exceptionOrNull() is AIConsent.Declined)
        assertEquals(1, asks)
    }

    @Test fun prompterShowsOneRequestUntilChosen() = runTest {
        val prompter = ConsentPrompter()
        val result = async { prompter.ask(Purpose.DICTATION) }
        testScheduler.runCurrent()
        val request = checkNotNull(prompter.pending) { "the sheet was not shown" }
        assertEquals(Purpose.DICTATION, request.purpose)
        request.choose(true)
        assertTrue(result.await())
        assertNull(prompter.pending)
    }

    @Test fun aCancelledAskTakesTheSheetDown() = runTest {
        val prompter = ConsentPrompter()
        val job = launch { prompter.ask(Purpose.VOICE) }
        testScheduler.runCurrent()
        assertNotNull(prompter.pending)
        job.cancel()
        testScheduler.runCurrent()
        assertNull(prompter.pending)
    }
}
