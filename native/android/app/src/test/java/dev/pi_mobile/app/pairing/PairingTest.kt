package dev.pi_mobile.app.pairing

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.pi_mobile.app.R
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.ui.PiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
class PairingTest {
    @get:Rule val rule = createComposeRule()

    private val piLink = "https://mac.tail1234.ts.net/#p=abc123." + "A".repeat(43)

    /** A camera that reads whatever the test puts in front of it. */
    private var seen by mutableStateOf<String?>(null)
    private val fakeCamera: @Composable (onPayload: (String) -> Unit, onUnavailable: () -> Unit) -> Unit = { onPayload, _ ->
        val code = seen
        LaunchedEffect(code) { if (code != null) onPayload(code) }
    }

    @Test fun aCodeThatIsNotPisIsRejectedWithTheHint() {
        val codes = mutableListOf<String>()
        rule.setContent { PiTheme { ScannerScreen(onCode = { codes += it }, onPaste = {}, onClose = {}, camera = fakeCamera) } }
        rule.onNodeWithText("Point at the code from /remote").assertExists()

        seen = "https://example.com/menu"
        rule.waitForIdle()
        rule.onNodeWithText("That code isn’t from pi. Scan the one /remote shows.").assertExists()
        assertEquals(emptyList<String>(), codes)

        // A pi link goes through, once, as scanned.
        seen = piLink
        rule.waitForIdle()
        seen = "$piLink&again"
        rule.waitForIdle()
        assertEquals(listOf(piLink), codes)
    }

    @Test fun aCameraThatCantStartMakesPastingThePrimaryWay() {
        rule.setContent {
            PiTheme {
                ScannerScreen(onCode = {}, onPaste = {}, onClose = {}, camera = { _, onUnavailable -> LaunchedEffect(Unit) { onUnavailable() } })
            }
        }
        rule.onNodeWithText("The camera isn’t available right now. Paste the link instead.").assertExists()
        rule.onNodeWithText("Paste link instead").assertExists()
    }

    @Test fun pairingErrorsSayWhatToDo() {
        val string: (Int) -> String = RuntimeEnvironment.getApplication()::getString
        assertEquals("That code was already used or has expired. Run /remote again for a new one.", pairingError(HubError.Expired, string))
        assertEquals("That code isn’t valid. Run /remote again for a new one.", pairingError(HubError.Unauthorized, string))
        assertEquals("This computer needs its secure address.", pairingError(HubError.Remote("This computer needs its secure address."), string))
        val network = string(R.string.pairing_network)
        assertEquals(network, pairingError(HubError.Network("timeout"), string))
        assertEquals(network, pairingError(IOException("reset"), string))
    }

    @Test fun theErrorShowsNextToTheButtons() {
        rule.setContent {
            PiTheme {
                PairingContent(
                    canScan = true, camera = CameraAccess.ASK, pairing = false, error = "That code isn’t valid. Run /remote again for a new one.",
                    onScan = {}, onPaste = {}, onOpenSettings = {},
                )
            }
        }
        rule.onNodeWithText("That code isn’t valid. Run /remote again for a new one.").assertExists()
        rule.onNodeWithText("Scan code").assertExists()
    }

    @Test fun cameraOffOffersSettingsAndPaste() {
        rule.setContent {
            PiTheme {
                PairingContent(canScan = true, camera = CameraAccess.DENIED, pairing = false, error = null, onScan = {}, onPaste = {}, onOpenSettings = {})
            }
        }
        rule.onNodeWithText("Open settings").assertExists()
        rule.onNodeWithText("Paste link").assertExists()
        rule.onNodeWithText("Scan code").assertDoesNotExist()
    }
}
