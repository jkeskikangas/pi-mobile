package dev.pi_mobile.app.dictation

import kotlinx.coroutines.CompletableDeferred

/** A recorder whose start and stop can be held open, to drive Dictation's ordering rules. */
class FakeRecorder : DictationRecorder {
    override var onEnded: ((String) -> Unit)? = null
    override var onLevel: ((Double) -> Unit)? = null
    var holdStart = false
    var holdStop = false
    var gate: CompletableDeferred<Unit>? = null
    var stopGate: CompletableDeferred<ByteArray>? = null
    var cancels = 0
    var startError: Exception? = null

    override suspend fun start() {
        startError?.let { throw it }
        if (holdStart) CompletableDeferred<Unit>().also { gate = it }.await()
    }

    override suspend fun stop(): ByteArray {
        if (holdStop) return CompletableDeferred<ByteArray>().also { stopGate = it }.await()
        return AUDIO
    }

    override fun cancel() {
        cancels += 1
        stopGate?.completeExceptionally(DictationError("cancelled."))
        stopGate = null
    }

    companion object {
        val AUDIO = "m4a".toByteArray()
    }
}
