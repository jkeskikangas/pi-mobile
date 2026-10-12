package dev.pi_mobile.app.shell

import android.Manifest
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
 * Presents the pairing-code scanner over the web shell for the page's "Add a computer" sheet: one scan at a time,
 * camera permission asked on first use. The shell shows the scanner sheet while [isOpen] and reports how it ended
 * with [finish]. Port of native/ios/Pi/Shell/ScanCenter.swift. Main thread only.
 *
 * @param hasCamera whether this phone has any camera (PackageManager.FEATURE_CAMERA_ANY).
 */
class ScanCenter(private val permissions: Permissions, private val hasCamera: () -> Boolean) : Scanner {
    private val _isOpen = MutableStateFlow(false)
    val isOpen: StateFlow<Boolean> = _isOpen.asStateFlow()

    /** True from the first permission check until [finish]: a second scan meanwhile is `busy`. */
    private var active = false
    private var pending: CompletableDeferred<ScanResult>? = null

    override suspend fun scan(): String = when (val r = open()) {
        is ScanResult.Link -> r.link
        ScanResult.Cancelled -> throw BridgeError("cancelled")
        ScanResult.Busy -> throw BridgeError("busy")
        is ScanResult.Unavailable -> throw BridgeError(r.message)
    }

    suspend fun open(): ScanResult {
        if (active) return ScanResult.Busy
        if (!hasCamera()) return ScanResult.Unavailable(UNSUPPORTED)
        active = true
        val allowed = try {
            permissions.request(Manifest.permission.CAMERA) == PermissionResult.GRANTED
        } catch (e: Exception) {
            active = false
            throw e
        }
        if (!allowed) {
            active = false
            return ScanResult.Unavailable(DENIED)
        }
        val d = CompletableDeferred<ScanResult>()
        pending = d
        _isOpen.value = true
        return d.await()
    }

    /** Ends the open scan (if any) with [result] and closes the sheet. Closing the sheet any other way is [ScanResult.Cancelled]. */
    fun finish(result: ScanResult) {
        val d = pending
        pending = null
        active = false
        _isOpen.value = false
        d?.complete(result)
    }

    companion object {
        const val UNSUPPORTED = "The camera isn't available on this phone. Paste the link instead."
        const val DENIED = "Camera access is off. Turn it on in Settings, or paste the link instead."

        /** For the scanner sheet when the camera exists but won't open (in use, restricted by policy). */
        const val UNAVAILABLE_NOW = "The camera isn't available right now. Paste the link instead."
    }
}
