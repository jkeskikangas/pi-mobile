package dev.pi_mobile.app.dictation

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Port of native/ios/PiTests/DictationTests.swift: BRIDGE.md → Dictation ordering. */
@OptIn(ExperimentalCoroutinesApi::class)
class DictationTest {
    private val f = FakeRecorder()

    private fun TestScope.make() = Dictation(f, CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)))

    @Test fun stopBeforeStartResolvesWaitsForIt() = runTest {
        val d = make()
        f.holdStart = true
        val s = async { d.start() }
        runCurrent()
        val stop = async { d.stop() }
        runCurrent()
        f.gate!!.complete(Unit)
        s.await()
        assertArrayEquals(FakeRecorder.AUDIO, stop.await())
        assertEquals(Dictation.State.IDLE, d.state)
    }

    @Test fun cancelDuringStartDiscardsWhenStartResolves() = runTest {
        val d = make()
        f.holdStart = true
        val s = async { d.start() }
        runCurrent()
        d.cancel()
        f.gate!!.complete(Unit)
        s.await()
        assertEquals(Dictation.State.IDLE, d.state)
        assertEquals(1, f.cancels)
    }

    @Test fun cancelDuringStopAndDoubleCancel() = runTest {
        val d = make()
        f.holdStop = true
        d.start()
        val stop = async { runCatching { d.stop() } }
        runCurrent()
        d.cancel()
        d.cancel()
        assertTrue(stop.await().isFailure)
        assertEquals(Dictation.State.IDLE, d.state)
        assertEquals(1, f.cancels)
        d.cancel() // idle: still fine
        d.start() // a fresh take works
        assertEquals(Dictation.State.RECORDING, d.state)
    }

    @Test fun systemEndTellsPageAndLevelsFlow() = runTest {
        val d = make()
        val sent = mutableListOf<String>()
        d.js = { sent += it }
        d.start()
        f.onLevel!!(0.5)
        f.onEnded!!("Dictation stopped: the microphone was disconnected.")
        f.onLevel!!(0.7)
        assertEquals(listOf(
            "window.PiNative?.level?.(0.500)",
            "window.PiNative?.dictationEnded?.(\"Dictation stopped: the microphone was disconnected.\")",
        ), sent)
        assertEquals(Dictation.State.IDLE, d.state)
        d.cancelIfActive()
        assertEquals(0, f.cancels)
    }

    @Test fun cancelIfActiveDrainsAPendingStart() = runTest {
        val d = make()
        f.holdStart = true
        val s = async { d.start() }
        runCurrent()
        val drained = async { d.cancelIfActive(); f.cancels }
        runCurrent()
        assertEquals(0, f.cancels)
        f.gate!!.complete(Unit)
        assertEquals("the mic was released before the caller resumed", 1, drained.await())
        s.await()
        assertEquals(Dictation.State.IDLE, d.state)
        assertEquals(1, f.cancels)
    }

    @Test fun consentComesFirstAndACancelMeanwhileGivesTheTakeUp() = runTest {
        val d = make()
        d.consent = { throw DictationError("needs your OK.") }
        assertEquals("needs your OK.", runCatching { d.start() }.exceptionOrNull()?.message)
        assertEquals(Dictation.State.IDLE, d.state)
        d.consent = { d.cancel() } // the web cancelled while the sheet was up
        assertEquals("cancelled.", runCatching { d.start() }.exceptionOrNull()?.message)
        assertEquals(Dictation.State.IDLE, d.state)
    }

    @Test fun aBlockedMicrophoneOffersSettings() = runTest {
        val d = make()
        val offered = mutableListOf<String>()
        d.onDenied = { offered += it }
        f.startError = DictationError(AudioRecorder.DENIED, settings = true)
        try { d.start(); fail() } catch (e: DictationError) { assertEquals("the page prefixes \"Microphone: \"", "access is off. Turn it on in Settings.", e.message) }
        assertEquals(listOf(AudioRecorder.DENIED), offered)
        assertEquals(Dictation.State.IDLE, d.state)
        f.startError = DictationError(AudioRecorder.DENIED) // just denied in the system dialog: no extra prompt
        runCatching { d.start() }
        assertEquals(1, offered.size)
    }

    @Test fun leavingTheScreenEndsTheTake() = runTest {
        val d = make()
        val sent = mutableListOf<String>()
        d.js = { sent += it }
        d.appStopped() // idle: nothing to tell
        assertEquals(emptyList<String>(), sent)
        d.start()
        d.appStopped()
        assertEquals(listOf("window.PiNative?.dictationEnded?.(\"Dictation stopped: pi left the screen.\")"), sent)
        assertEquals(1, f.cancels)
        assertEquals(Dictation.State.IDLE, d.state)
        // A start still pending when the app left releases the microphone once it resolves.
        f.holdStart = true
        val s = async { d.start() }
        runCurrent()
        d.appStopped()
        f.gate!!.complete(Unit)
        s.await()
        assertEquals(2, f.cancels)
        assertEquals(Dictation.State.IDLE, d.state)
    }

    @Test fun revokingConsentDropsTheTakeAndThePageUi() = runTest {
        val d = make()
        val sent = mutableListOf<String>()
        d.js = { sent += it }
        d.consentRevoked() // idle: nothing to tell
        assertEquals(emptyList<String>(), sent)
        d.start()
        d.consentRevoked()
        assertEquals(listOf("window.PiNative?.dictationEnded?.(\"Voice sharing is off.\")"), sent)
        assertEquals(1, f.cancels)
        assertEquals(Dictation.State.IDLE, d.state)
    }
}
