package dev.pi_mobile.app.voice

import android.content.Context
import android.media.AudioManager
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.intents.VoiceShortcuts
import dev.pi_mobile.app.voiceui.LockedVoiceActions
import dev.pi_mobile.app.voiceui.VoiceActions
import dev.pi_mobile.app.voiceui.VoiceAttention
import dev.pi_mobile.app.voiceui.VoiceQuestion
import dev.pi_mobile.app.voiceui.VoiceTurns
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The device-facing voice parts that run under Robolectric: the bundled core, the mic mute, shortcuts, the lock screen. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VoiceAndroidTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test fun theAppRunsExactlyTheWebsVoiceCore() {
        val bundled = context.assets.open("voice-core.js").bufferedReader().use { it.readText() }
        assertEquals(File(System.getProperty("pi.repo"), "web/voice-core.js").readText(), bundled)
    }

    @Test fun aMuteLeftByPiIsLiftedButNeverTheUsersOwn() {
        val audio = context.getSystemService(AudioManager::class.java)
        // The user's own mute: not pi's to lift.
        audio.isMicrophoneMute = true
        AudioSessionController.clearStaleMute(context)
        assertTrue(audio.isMicrophoneMute)
        // pi muted it, then voice mode ended without unmuting (a crash).
        AudioSessionController(context).setInputMuted(true)
        AudioSessionController.clearStaleMute(context)
        assertFalse(audio.isMicrophoneMute)
        // Unmuted by pi itself: nothing stale left.
        AudioSessionController(context).setInputMuted(true)
        AudioSessionController(context).setInputMuted(false)
        audio.isMicrophoneMute = true
        AudioSessionController.clearStaleMute(context)
        assertTrue(audio.isMicrophoneMute)
    }

    @Test fun theShortcutFollowsTheMachineList() {
        VoiceShortcuts.update(context, paired = true)
        val shortcut = ShortcutManagerCompat.getDynamicShortcuts(context).single()
        assertEquals(VoiceShortcuts.ID, shortcut.id)
        assertTrue(shortcut.intent.getBooleanExtra(VoiceHost.EXTRA_VOICE, false))
        VoiceShortcuts.update(context, paired = false)
        assertTrue(ShortcutManagerCompat.getDynamicShortcuts(context).isEmpty())
    }

    @Test fun overTheLockScreenOnlyMuteEndAndSayingNoAct() = runBlocking {
        val done = mutableListOf<String>()
        val base = object : VoiceActions {
            override fun pressStart() = true.also { done.add("pressStart") }
            override fun pressEnd(held: Boolean) { done.add("pressEnd") }
            override fun tap() { done.add("tap") }
            override fun toggleMute() { done.add("mute") }
            override fun end() { done.add("end") }
            override suspend fun answer(option: VoiceQuestion.Option, questionId: String) = true.also { done.add("answer") }
            override fun cancelGrace() { done.add("cancelGrace") }
            override suspend fun doItNow() { done.add("doItNow") }
            override fun switchSession(agent: String, machine: String) { done.add("switch") }
            override suspend fun setPersona(id: String) { done.add("persona") }
            override fun playSample(id: String) { done.add("sample") }
            override fun setAttention(attention: VoiceAttention) { done.add("attention") }
            override fun setTurns(turns: VoiceTurns) { done.add("turns") }
            override fun revokeConsent() { done.add("revoke") }
        }
        var unlocks = 0
        val deferred = mutableListOf<() -> Unit>()
        val locked = LockedVoiceActions(base) { then -> unlocks++; deferred.add(then) }
        assertFalse(locked.pressStart())
        locked.tap()
        assertFalse(locked.answer(VoiceQuestion.Option("Yes", JsonPrimitive(true)), "q"))
        locked.doItNow()
        locked.switchSession("b1", "m2")
        locked.setPersona("cedar")
        locked.setAttention(VoiceAttention.GLANCE)
        locked.setTurns(VoiceTurns.TAP)
        locked.revokeConsent()
        locked.toggleMute()
        locked.end()
        locked.cancelGrace()
        assertEquals(listOf("mute", "end", "cancelGrace"), done)
        assertEquals(8, unlocks)
        // Once unlocked, the switch, settings and the circle go ahead; an answer or Do it now is tapped again.
        deferred.forEach { it() }
        assertEquals(listOf("mute", "end", "cancelGrace", "tap", "switch", "attention", "turns", "revoke"), done)
    }
}
