package dev.pi_mobile.app.app

import dev.pi_mobile.app.shell.BridgeError
import dev.pi_mobile.app.shell.PermissionResult
import dev.pi_mobile.app.voice.VoiceHost
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/** The one way into voice mode: consent, then the microphone (Settings offered when blocked), then VoiceHost. */
class AppVoiceTest {
    private val steps = mutableListOf<String>()
    private var mic = PermissionResult.GRANTED
    private var consentError: String? = null

    private val voice = AppVoice(
        consent = { steps += "consent"; consentError?.let { throw BridgeError(it) } },
        microphone = { steps += "mic"; mic },
        blocked = { steps += "settings" },
        open = { agent, machine -> steps += "open $agent $machine" },
        end = { steps += "end" },
    )

    private fun start(agent: String?, machine: String?) = runBlocking { runCatching { voice.start(agent, machine) }.exceptionOrNull()?.message }

    @Test fun consentThenMicrophoneThenVoiceMode() {
        assertEquals(null, start("a1", "e1"))
        assertEquals(listOf("consent", "mic", "open a1 e1"), steps)
        steps.clear()
        start(null, "")
        assertEquals("an empty machine lets voice mode pick", listOf("consent", "mic", "open null null"), steps)
    }

    @Test fun noConsentAsksNoMicrophone() {
        consentError = "Voice mode needs your OK to send your voice. Try again to see the details."
        assertEquals(consentError, start("a1", "e1"))
        assertEquals(listOf("consent"), steps)
    }

    @Test fun aBlockedMicrophoneOffersSettings() {
        mic = PermissionResult.DENIED
        assertEquals(VoiceHost.MIC_OFF, start("a1", "e1"))
        assertEquals("just said no: no extra prompt", listOf("consent", "mic"), steps)
        steps.clear()
        mic = PermissionResult.BLOCKED
        assertEquals(VoiceHost.MIC_OFF, start("a1", "e1"))
        assertEquals(listOf("consent", "mic", "settings"), steps)
    }
}
