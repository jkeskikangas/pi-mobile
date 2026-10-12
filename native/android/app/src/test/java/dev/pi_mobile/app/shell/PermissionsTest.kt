package dev.pi_mobile.app.shell

import android.Manifest
import android.os.Looper
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.app.MainActivity
import dev.pi_mobile.app.app.PiApplication
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** A permission dialog that outlives its activity (dark mode, font size) must not leave the bridge call hanging. */
@RunWith(RobolectricTestRunner::class)
class PermissionsTest {
    @Test fun aRecreatedActivityEndsThePendingRequest() {
        val app = ApplicationProvider.getApplicationContext<PiApplication>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
            val answer = GlobalScope.async(Dispatchers.Main, CoroutineStart.UNDISPATCHED) { app.permissions.request(Manifest.permission.RECORD_AUDIO) }
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse("the system dialog is up", answer.isCompleted)
            scenario.recreate()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(answer.isCompleted)
            assertEquals(PermissionResult.DENIED, answer.getCompleted())
        }
    }
}
