package dev.pi_mobile.app.shell

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** How a scan ended (BRIDGE.md `scan`). */
sealed interface ScanResult {
    data class Link(val link: String) : ScanResult
    data object Cancelled : ScanResult
    data object Busy : ScanResult

    /** Shown to the user as is. */
    data class Unavailable(val message: String) : ScanResult
}

/**
 * Presents the pairing-code scanner over the web shell for the page's "Add a computer" sheet, one scan at a time.
 * MainActivity shows pairing/ScannerSheet while [isOpen] (it checks the camera and asks for access) and reports how
 * it ended with [finish]. Port of native/ios/Pi/Shell/ScanCenter.swift. Main thread only.
 */
class ScanCenter : Scanner {
    private val _isOpen = MutableStateFlow(false)
    val isOpen: StateFlow<Boolean> = _isOpen.asStateFlow()

    private var pending: CompletableDeferred<ScanResult>? = null

    override suspend fun scan(): String = when (val r = open()) {
        is ScanResult.Link -> r.link
        ScanResult.Cancelled -> throw BridgeError("cancelled")
        ScanResult.Busy -> throw BridgeError("busy")
        is ScanResult.Unavailable -> throw BridgeError(r.message)
    }

    suspend fun open(): ScanResult {
        if (pending != null) return ScanResult.Busy
        val d = CompletableDeferred<ScanResult>()
        pending = d
        _isOpen.value = true
        return d.await()
    }

    /** Ends the open scan (if any) with [result] and closes the sheet. */
    fun finish(result: ScanResult) {
        val d = pending
        pending = null
        _isOpen.value = false
        d?.complete(result)
    }
}
