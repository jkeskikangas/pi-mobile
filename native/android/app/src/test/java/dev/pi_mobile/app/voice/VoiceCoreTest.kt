package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.obj
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The QuickJS bridge to web/voice-core.js (the repo copy, which the build bundles). Port of VoiceCoreTests.swift. */
class VoiceCoreTest {
    private val core = repoVoiceCore()

    @After fun tearDown() = core.close()

    @Test fun loadsTheScript() {
        assertEquals("repo", core.source)
        assertTrue(core.help.startsWith("Just talk to pi"))
        assertEquals(setOf("pushToTalk", "openMic", "eyesFree", "glance"), core.settings.toSet())
        assertEquals(listOf(listOf(880.0, 70.0, 0.18)), core.earcons["listen"])
    }

    @Test fun decisions() {
        assertEquals("quiet", core.parseCommand("hey pi, stop")?.kind) // stop is about the voice, never pi's work
        assertEquals("stopPi", core.parseCommand("stop pi")?.kind)
        assertNull(core.parseCommand("stop the build after the tests run please"))
        val deploy = obj("id" to "p", "kind" to "confirm", "title" to "Deploy to production?")
        assertTrue(core.isDestructive(deploy))
        assertEquals("deploy", core.answerFor(deploy, "yeah").needConfirm)
        assertFalse(core.answerFor(deploy, "yeah").answered)
        assertEquals(JsonPrimitive(true), core.answerFor(deploy, "yes, deploy").value)
        assertEquals(JsonPrimitive(false), core.answerFor(deploy, "no").value)
        val select = obj("id" to "s", "kind" to "select", "title" to "Which?", "options" to listOf("alpha", "beta"))
        val cancel = core.answerFor(select, "never mind")
        assertTrue(cancel.answered)
        assertNull(cancel.value)
        assertEquals(JsonPrimitive("beta"), core.answerFor(select, "the second one").value)
        assertTrue(core.answerFor(select, "purple").unclear)
        assertTrue(core.requestNames(deploy, "deploy the app to production"))
        assertFalse(core.requestNames(deploy, "deploy it"))
        assertTrue(core.isBackchannel("mm-hmm"))
        assertFalse(core.isBackchannel("yeah", answering = true))
        assertTrue(core.isEcho("yes deploy", "Say yes, deploy to confirm"))
        assertTrue(core.isSignificant("git push origin main"))
        assertTrue(core.incomplete("and then"))
        assertEquals(listOf("One.", "Two!"), core.chunks("One. Two!"))
        assertTrue(core.speakPrompt(deploy).contains("Say \"yes, deploy\" to confirm"))
        assertEquals("what's it doing", core.norm("What’s it doing?"))
    }

    @Test fun matchSessionAndVad() {
        val list = listOf(
            obj("agent" to "m1/a", "name" to "api", "cwd" to "/x/api", "machine" to "laptop"),
            obj("agent" to "m2/b", "name" to "api", "cwd" to "/y/api", "machine" to "box"),
            obj("agent" to "m2/c", "name" to "web", "cwd" to "/y/web", "machine" to "box"),
        )
        assertEquals(VoiceCore.Match.One(2), core.matchSession(list, "web"))
        assertEquals(VoiceCore.Match.Ambiguous(listOf(0, 1)), core.matchSession(list, "api"))
        assertEquals(VoiceCore.Match.One(1), core.matchSession(list, "the api on the box"))
        assertEquals(VoiceCore.Match.None, core.matchSession(list, "zebra"))
        val vad = core.vad(hangMs = 800.0, minSpeechMs = 120.0)
        val events = mutableListOf<String>()
        for (i in 0 until 20) vad.feed(0.2, i * 20.0)?.let(events::add)
        for (i in 20 until 80) vad.feed(0.0, i * 20.0)?.let(events::add)
        assertEquals(listOf("start", "end"), events)
        vad.close()
    }
}
