package dev.pi_mobile.app.shell

import android.Manifest
import android.app.Application
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** One scan at a time, camera checks first (BRIDGE.md `scan`). */
@RunWith(RobolectricTestRunner::class)
class ScanCenterTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val permissions = Permissions(app)

    @Test fun oneScanAtATimeAndClosingCancels() = runBlocking(Dispatchers.Unconfined) {
        shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
        val center = ScanCenter(permissions) { true }
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
    }

    @Test fun noCameraOrNoAccessIsASentence() = runBlocking {
        assertEquals(ScanResult.Unavailable(ScanCenter.UNSUPPORTED), ScanCenter(permissions) { false }.open())
        // No activity to ask from and not granted: as if denied.
        assertEquals(ScanResult.Unavailable(ScanCenter.DENIED), ScanCenter(permissions) { true }.open())
    }
}
