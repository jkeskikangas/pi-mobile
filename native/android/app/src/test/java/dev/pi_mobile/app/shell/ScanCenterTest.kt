package dev.pi_mobile.app.shell

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** One scan at a time (BRIDGE.md `scan`). */
class ScanCenterTest {
    @Test fun oneScanAtATimeAndEachEndingIsTheBridgesReply() = runBlocking(Dispatchers.Unconfined) {
        val center = ScanCenter()
        val first = async { runCatching { center.scan() } }
        yield()
        assertTrue(center.isOpen.value)
        assertEquals("busy", runCatching { center.scan() }.exceptionOrNull()?.message)
        center.finish(ScanResult.Cancelled)
        assertEquals("cancelled", first.await().exceptionOrNull()?.message)
        assertFalse(center.isOpen.value)

        val second = async { center.scan() }
        yield()
        center.finish(ScanResult.Link("https://mac.ts.net/#p=x.y"))
        assertEquals("https://mac.ts.net/#p=x.y", second.await())

        val third = async { runCatching { center.scan() } }
        yield()
        center.finish(ScanResult.Unavailable("Camera access is off. Turn it on in Settings, or paste the link instead."))
        assertEquals("Camera access is off. Turn it on in Settings, or paste the link instead.", third.await().exceptionOrNull()?.message)
    }
}
