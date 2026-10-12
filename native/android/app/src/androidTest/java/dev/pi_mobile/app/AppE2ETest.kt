package dev.pi_mobile.app

import android.content.Intent
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import dev.pi_mobile.app.app.DebugLaunch
import dev.pi_mobile.app.app.MainActivity
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.regex.Pattern

/**
 * End to end on an emulator against the `npm run ui` fixture hub (port of native/ios/PiUITests/AppE2ETests.swift).
 * Run with `scripts/e2e.sh`, which starts the fixture, forwards its port with `adb reverse`, passes the pairing
 * link as the instrumentation argument `piPairLink` and checks the fixture log for the transcribe calls afterwards.
 * Skipped without a link. Screenshots go to the app's external files dir `e2e/` (the script pulls them).
 *
 * Web elements are found by their accessible names, which the WebView exposes to UiAutomator as text or
 * content description.
 */
@RunWith(AndroidJUnit4::class)
class AppE2ETest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val context = instrumentation.targetContext
    private val shots = File(context.getExternalFilesDir(null), "e2e").apply { mkdirs() }

    @Before fun launch() {
        val link = InstrumentationRegistry.getArguments().getString("piPairLink")
        assumeTrue("piPairLink not set; run native/android/scripts/e2e.sh", !link.isNullOrEmpty())
        context.startActivity(
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                .putExtra(DebugLaunch.RESET, true)
                .putExtra(DebugLaunch.PAIR_LINK, link),
        )
    }

    @Test fun webVoiceDictationAndNotifications() {
        val voice = needLabel("Voice mode: talk with pi hands-free", 30_000, "web UI did not load")
        shot("01-web")

        // Voice: consent first (piReset cleared any earlier OK), then the microphone, then the native screen. The
        // fixture has no realtime, so voice mode runs basic voice.
        voice.click()
        need(By.text("Where your voice goes"), 10_000, "no consent sheet before voice mode")
        shot("02a-consent")
        need(By.text("Allow"), 2_000, "no Allow on the consent sheet").click()
        allowMicrophone()
        val end = needLabel("End voice mode", 15_000, "native voice screen did not open")
        need(By.text(Pattern.compile("(?is).*basic voice.*")), 8_000, "no basic voice note")
        shot("02-voice-basic")
        end.click()
        needLabel("Voice mode: talk with pi hands-free", 10_000, "End did not return to the web UI")
        check(find("End voice mode") == null) { "the voice screen is still up" }
        shot("03-after-voice")

        // Dictation: tap to start, wait over the 600 ms minimum, tap Finish; the web then calls transcribe.
        needLabel(MIC, 5_000, "no mic button").click()
        Thread.sleep(1_600)
        shot("04-dictating")
        needLabel("Finish dictation", 3_000, "not recording").click()
        need(By.text(Pattern.compile("(?s).*round them to cents.*")), 10_000, "no transcription in the composer")
        shot("05-dictation-done")
        device.pressBack() // the transcription focuses the composer: put the keyboard away

        // Hold to talk: a long press on the mic.
        val mic = needLabel(MIC, 5_000, "mic not reachable after the first take")
        val c = mic.visibleCenter
        device.swipe(c.x, c.y, c.x, c.y, HOLD_STEPS)
        Thread.sleep(2_500) // the fixture answers transcribe after 1.2 s
        shot("06-hold-done")
        device.pressBack()

        // The menu's Notifications row comes from the app (push.status: no Firebase in this build), and voice
        // sharing, allowed above, can be stopped.
        needLabel("Menu", 5_000, "no menu button").click()
        need(By.text(Pattern.compile("(?s).*aren.t available in this build.*")), 5_000, "no push-unavailable note")
        need(By.text(Pattern.compile("(?s)Stop sharing my voice.*")), 5_000, "no consent row in the menu")
        shot("07-menu-notifications")
    }

    /** A fresh install asks for the microphone after the consent sheet (the permission controller's dialog). */
    private fun allowMicrophone() {
        device.wait(Until.findObject(By.res("com.android.permissioncontroller:id/permission_allow_foreground_only_button")), 5_000)?.click()
    }

    /** A web or native element by its accessible name (WebView reports it as text, Compose as content description). */
    private fun find(name: String): UiObject2? {
        fresh()
        return device.findObject(By.text(name)) ?: device.findObject(By.desc(name))
    }

    /**
     * The WebView doesn't always announce its changes, so UiAutomator's cached nodes go stale (a sheet that is open
     * on screen isn't found). Android 14+ can drop the cache before each lookup.
     */
    private fun fresh() {
        if (Build.VERSION.SDK_INT >= 34) instrumentation.uiAutomation.clearCache()
    }

    private fun needLabel(name: String, timeoutMs: Long, why: String): UiObject2 {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            find(name)?.let { return it }
            Thread.sleep(200)
        }
        return failWith(why)
    }

    private fun need(selector: BySelector, timeoutMs: Long, why: String): UiObject2 {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            fresh()
            device.findObject(selector)?.let { return it }
            Thread.sleep(200)
        }
        return failWith(why)
    }

    /** Fails with a screenshot and the window hierarchy next to the shots. */
    private fun failWith(why: String): Nothing {
        shot("failed")
        device.dumpWindowHierarchy(File(shots, "failed-tree.xml"))
        throw AssertionError(why)
    }

    private fun shot(name: String) {
        device.waitForIdle()
        device.takeScreenshot(File(shots, "$name.png"))
    }

    private companion object {
        const val MIC = "Dictate: hold to talk, or tap to start and stop"

        /** About 1.6 s: UiDevice.swipe takes ~5 ms per step. */
        const val HOLD_STEPS = 320
    }
}
