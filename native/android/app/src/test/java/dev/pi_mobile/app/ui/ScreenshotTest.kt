package dev.pi_mobile.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import dev.pi_mobile.app.consent.AIConsent
import dev.pi_mobile.app.consent.ConsentContent
import dev.pi_mobile.app.pairing.CameraAccess
import dev.pi_mobile.app.pairing.PairingContent
import dev.pi_mobile.app.pairing.ScannerScreen
import dev.pi_mobile.app.shell.ShellPhase
import dev.pi_mobile.app.shell.ShellScreen
import dev.pi_mobile.app.voiceui.VoiceFixtures
import dev.pi_mobile.app.voiceui.VoicePersonaList
import dev.pi_mobile.app.voiceui.VoiceScreen
import dev.pi_mobile.app.voiceui.VoiceSessionList
import dev.pi_mobile.app.voiceui.VoiceSettingsContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Every native screen and voice state, light and dark, rendered by Robolectric's native graphics on a
 * 393 × 852 dp phone. Writes PNGs to build/shots (`-Ppi.shots` writes native/android/shots instead).
 * Look at them: this only proves they render.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w393dp-h852dp-xhdpi")
class ScreenshotTest {
    @get:Rule val rule = createComposeRule()

    private val out = File(System.getProperty("pi.shots") ?: "build/shots")
    private var screen: (@Composable () -> Unit)? by mutableStateOf(null)

    /** Shows [content] in both themes, lets animations run for [millis], and saves `<name>-light.png` / `-dark.png`. */
    private fun shot(name: String, millis: Long = 1200, content: @Composable () -> Unit) {
        for (dark in listOf(false, true)) {
            // A fresh composition per shot: nothing remembered (the orb's eased colours) leaks into the next one.
            screen = { key(name, dark) { PiTheme(darkTheme = dark) { content() } } }
            rule.mainClock.advanceTimeBy(millis)
            val file = File(out, "$name-${if (dark) "dark" else "light"}.png").apply { parentFile?.mkdirs() }
            rule.onRoot().captureRoboImage(file)
        }
    }

    private fun start() {
        // Without the Roborazzi Gradle plugin, captures are written only in record mode.
        System.setProperty("roborazzi.test.record", "true")
        rule.setContent { screen?.invoke() }
    }

    /** The largest font size Android offers (200%): layouts must still fit and stay usable. */
    @Composable
    private fun LargeText(content: @Composable () -> Unit) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f), content = content)
    }

    /** A bottom sheet's body over a scrim, as it sits on a phone. */
    @Composable
    private fun Sheet(content: @Composable () -> Unit) {
        Box(Modifier.fillMaxSize().background(PiTheme.colors.scrim)) {
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .padding(top = 56.dp)
                    .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                    .background(PiTheme.colors.bg)
                    .padding(top = 20.dp),
            ) { content() }
        }
    }

    @Test fun pairing() {
        start()
        shot("pairing") { PairingContent(true, CameraAccess.ASK, pairing = false, error = null, onScan = {}, onPaste = {}, onOpenSettings = {}) }
        shot("pairing-error") {
            PairingContent(
                true, CameraAccess.GRANTED, pairing = false,
                error = "That code was already used or has expired. Run /remote again for a new one.",
                onScan = {}, onPaste = {}, onOpenSettings = {},
            )
        }
        shot("pairing-camera-off") { PairingContent(true, CameraAccess.DENIED, pairing = false, error = null, onScan = {}, onPaste = {}, onOpenSettings = {}) }
        shot("pairing-busy") { PairingContent(true, CameraAccess.GRANTED, pairing = true, error = null, onScan = {}, onPaste = {}, onOpenSettings = {}) }
        shot("scanner") { ScannerScreen(onCode = {}, onPaste = {}, onClose = {}, camera = { _, _ -> }) }
    }

    @Test fun consent() {
        start()
        shot("consent") { Sheet { ConsentContent(AIConsent.Purpose.VOICE, onChoice = {}) } }
        shot("consent-large-text") { LargeText { Sheet { ConsentContent(AIConsent.Purpose.DICTATION, onChoice = {}) } } }
    }

    @Test fun shell() {
        start()
        shot("offline") { ShellScreen("MacBook Pro", ShellPhase.Offline("Can’t reach your computer."), onRetry = {}) {} }
        shot("loading") { ShellScreen("MacBook Pro", ShellPhase.Loading, onRetry = {}) {} }
    }

    @Test fun voice() {
        start()
        for (name in VoiceFixtures.names) {
            shot("voice/$name") { VoiceScreen(VoiceFixtures.model(name), VoiceFixtures.NoActions, levels = { VoiceFixtures.levels(name) }) }
        }
        for (name in listOf("asking", "grace", "listening")) {
            shot("voice/$name-large-text") {
                LargeText { VoiceScreen(VoiceFixtures.model(name), VoiceFixtures.NoActions, levels = { VoiceFixtures.levels(name) }) }
            }
        }
        val model = VoiceFixtures.model("listening")
        shot("voice/settings") { Sheet { VoiceSettingsContent(model, VoiceFixtures.NoActions, onDone = {}, onVoices = {}, onRevoke = {}) } }
        shot("voice/voices") { Sheet { VoicePersonaList(model, VoiceFixtures.NoActions, onBack = {}, onDone = {}) } }
        shot("voice/sessions") { Sheet { VoiceSessionList(model, onDone = {}, onPick = {}) } }
    }
}
