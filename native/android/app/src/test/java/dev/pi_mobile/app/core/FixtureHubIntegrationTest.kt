package dev.pi_mobile.app.core

import dev.pi_mobile.app.core.HubClient.Update
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Against the `npm run ui` fixture hub. Run with native/android/scripts/integration.sh, which starts the
 * fixture, passes its pairing link as the `PI_PAIR_LINK` system property and types `ask` into it.
 * Skipped without a link. Port of native/ios/PiIntegrationTests/FixtureHubTests.swift.
 */
class FixtureHubIntegrationTest {
    @Test fun pairCallHubStreamEventsAndAnswerAPrompt() = runBlocking {
        val text = System.getProperty("PI_PAIR_LINK") ?: System.getenv("PI_PAIR_LINK")
        val link = text?.let { PairingLink.parse(it) }
        assumeTrue("PI_PAIR_LINK not set; run native/android/scripts/integration.sh", link != null)

        val machine = HubClient.pair(link!!, "Android · pi app (test)")
        val client = HubClient(machine)
        val hub = client.hub()
        assertFalse(hub.hubId.isEmpty())
        assertFalse(hub.agents.isEmpty())

        var sawHello = false
        var sawInfo = false
        var answered: String? = null
        withTimeout(60_000) {
            client.updates().filterIsInstance<Update.Event>().first { (ev) ->
                when (ev.type) {
                    "hello" -> sawHello = true
                    "info" -> sawInfo = true
                    "prompt" -> {
                        val id = ev.raw["prompt"]["id"].string!!
                        client.agent(ev.agent!!, "answer", obj("id" to id, "value" to true))
                        answered = id
                    }
                }
                ev.type == "prompt_end" && answered != null && ev.raw["id"].string == answered
            }
        }
        assertTrue(sawHello)
        assertTrue(sawInfo)
        assertNotNull("no prompt arrived: the script types `ask` into the fixture", answered)
    }
}
