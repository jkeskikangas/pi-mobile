package dev.pi_mobile.app.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.isNull
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import dev.pi_mobile.app.push.NotificationPermission
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Push through the relay: register, hand each computer {url, cap}, re-register when a computer lost it,
 * back off when the relay can't answer, and take the cap back on off. Port of PiTests/PushRelayTests.swift
 * (MockWebServer stands in for the relay, [Hub] for each computer).
 */
@RunWith(RobolectricTestRunner::class)
class PushRelayTest {
    private val server = MockWebServer()
    private val prefs = Prefs(ApplicationProvider.getApplicationContext<Context>())
    private var t = 1_000_000_000L
    private var granted = true
    private var fcmToken: String? = TOKEN
    private val jobs = SupervisorJob()

    private val mac = Machine(id = "e1", name = "mac", origin = "https://mac.tail1.ts.net", d = "d1", k = Base64Url.encode(ByteArray(32) { 1 }))
    private val box = Machine(id = "e2", name = "box", origin = "https://box.tail1.ts.net", d = "d2", k = Base64Url.encode(ByteArray(32) { 2 }))
    private var machines = listOf(mac, box)
    private val hubs = mutableMapOf("e1" to Hub(), "e2" to Hub())

    /** A computer that answers `hub` with its relay state and records `push` calls. */
    class Hub(var relay: Boolean = true) {
        var relayOn = false
        var down = false
        var failPushes = 0
        val pushes = mutableListOf<JsonObject>()

        fun rpc(m: String, p: JsonObject): JsonElement {
            if (down) throw HubError.Network("Can't reach your computer.")
            if (m == "hub") return if (relay) obj("relay" to true, "relayOn" to relayOn) else obj("apns" to false)
            if (failPushes > 0) { failPushes--; throw HubError.Network("Your computer didn't answer in time.") }
            pushes += p
            if (p["relay"] is JsonNull) relayOn = false else if (p["relay"] != null) relayOn = true
            return obj("ok" to true, "relay" to true, "relayOn" to relayOn)
        }
    }

    private val permission = object : NotificationPermission {
        override suspend fun request() = granted
        override fun state() = if (granted) "granted" else "denied"
    }

    private fun center(on: Boolean = true, relay: Boolean = true): PushCenter {
        prefs.notificationsOn = on
        prefs.pushToken = TOKEN
        return PushCenter(
            prefs = prefs,
            machines = { machines },
            hubs = { m, method, p -> hubs.getValue(m.id).rpc(method, p) },
            permission = permission,
            token = { fcmToken },
            relay = if (relay) server.url("/") else null,
            now = { t },
            scope = CoroutineScope(jobs + Dispatchers.IO),
        )
    }

    private val url get() = server.url("/").toString().trimEnd('/')
    private fun sent(cap: String) = obj("relay" to obj("url" to url, "cap" to cap))
    private fun caps(vararg caps: String) = caps.forEach { server.enqueue(MockResponse().setBody("""{"cap":"$it"}""")) }
    private fun idle() = runBlocking { jobs.children.toList().joinAll() }

    @Before fun setUp() = server.start()

    @After fun tearDown() = server.shutdown()

    @Test fun registerRequestShapeAndAnswers() = runBlocking {
        caps("cap-1")
        center().reconcile()
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/v1/register", req.path)
        assertEquals(obj("platform" to "fcm", "token" to TOKEN), parseJson(req.body.readUtf8()))
        assertEquals("xyz", PushCenter.relayCap(200, """{"cap":"xyz"}"""))
        assertThrows(PushCenter.Failure::class.java) { PushCenter.relayCap(200, "<html>") }
        assertEquals("The notification relay is busy. Try again in a minute.", assertThrows(PushCenter.Failure::class.java) { PushCenter.relayCap(429, "") }.message)
        assertThrows(PushCenter.RelayNotReady::class.java) { PushCenter.relayCap(501, """{"error":"fcm not configured"}""") }
        assertNull(PushCenter.relayUrl(""))
        assertNull(PushCenter.relayUrl("http://relay.example"))
        assertNull(PushCenter.relayUrl("https://relay.example/?x=1"))
        assertEquals("https://relay.example/", PushCenter.relayUrl(" https://relay.example ").toString())
    }

    @Test fun everyComputerGetsTheCapOnce() = runBlocking {
        caps("cap-1")
        val c = center()
        c.reconcile()
        assertEquals(1, server.requestCount)
        assertEquals(listOf(sent("cap-1")), hubs["e1"]!!.pushes)
        assertEquals(listOf(sent("cap-1")), hubs["e2"]!!.pushes)
        c.reconcile()
        assertEquals("in line: nothing sent again", 1, hubs["e1"]!!.pushes.size)
        assertEquals(1, server.requestCount)
        // A computer added later just gets the current cap.
        machines = machines + Machine(id = "e3", name = "pi", origin = "https://pi.tail1.ts.net", d = "d3", k = mac.k)
        hubs["e3"] = Hub()
        c.reconcile()
        assertEquals(listOf(sent("cap-1")), hubs["e3"]!!.pushes)
        assertEquals(1, server.requestCount)
    }

    @Test fun aComputerThatLostTheCapTriggersReRegistration() = runBlocking {
        caps("cap-1", "cap-2")
        val c = center()
        c.reconcile()
        hubs["e1"]!!.relayOn = false // the computer dropped it (the relay said the cap is gone)
        c.reconcile()
        assertEquals(2, server.requestCount)
        assertEquals(sent("cap-2"), hubs["e1"]!!.pushes.last())
        c.reconcile()
        assertEquals("the others follow the new cap", sent("cap-2"), hubs["e2"]!!.pushes.last())
        assertEquals(2, server.requestCount)
    }

    @Test fun aNewTokenRegistersAgain() = runBlocking {
        caps("cap-1", "cap-2")
        val c = center()
        c.reconcile()
        server.takeRequest()
        c.tokenChanged("$TOKEN-beef")
        idle()
        assertEquals(2, server.requestCount)
        assertEquals("$TOKEN-beef", parseJson(server.takeRequest().body.readUtf8())["token"].string)
        assertEquals(sent("cap-2"), hubs["e1"]!!.pushes.last())
        assertEquals(sent("cap-2"), hubs["e2"]!!.pushes.last())
    }

    @Test fun everyLaunchSendsTheCapAgain() = runBlocking {
        caps("cap-1")
        center().reconcile()
        center().start()
        idle()
        assertEquals("the cap is still good: no register", 1, server.requestCount)
        assertEquals(listOf(sent("cap-1"), sent("cap-1")), hubs["e1"]!!.pushes)
    }

    @Test fun relayNotConfiguredBacksOffForSixHours() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(501).setBody("""{"error":"fcm not configured on this relay"}"""))
        val c = center()
        repeat(5) { c.reconcile() }
        assertEquals("one try, then it waits", 1, server.requestCount)
        assertEquals("no cap: nothing sent", emptyList<JsonObject>(), hubs["e1"]!!.pushes)
        t += 5 * 3_600_000L
        c.reconcile()
        assertEquals(1, server.requestCount)
        t += 2 * 3_600_000L
        caps("cap-ok")
        c.reconcile()
        assertEquals(2, server.requestCount)
        assertEquals(sent("cap-ok"), hubs["e1"]!!.pushes.last())
    }

    @Test fun otherFailuresBackOffForFiveMinutes() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500))
        val c = center()
        c.reconcile()
        assertEquals("The notification relay refused this phone (HTTP 500). Try again later.", c.lastRelayError?.message)
        t += 4 * 60_000L
        c.reconcile()
        assertEquals(1, server.requestCount)
        t += 2 * 60_000L
        server.shutdown() // the relay is down: refused connections
        c.reconcile()
        assertEquals("Couldn't reach the notification relay. Try again later.", c.lastRelayError?.message)
        assertEquals("Couldn't reach the notification relay. Try again later.", c.notifyStatus["e1"])
    }

    @Test fun eachComputerSaysWhetherItWillNotifyAndWhyNot() = runBlocking {
        caps("cap-1")
        hubs["e2"]!!.down = true
        val c = center()
        c.reconcile()
        assertEquals(1, c.notifyingCount)
        assertEquals(mapOf("e1" to null, "e2" to "isn't reachable right now"), c.notifyStatus)
        assertEquals(
            listOf(obj("machine" to "e1", "notify" to true), obj("machine" to "e2", "notify" to false, "why" to "isn't reachable right now")),
            c.status()["computers"],
        )
        assertEquals(true, c.status()["on"].bool)
        // An older hub without the relay can't notify, and says so.
        hubs["e1"] = Hub(relay = false)
        c.reconcile()
        assertEquals(0, c.notifyingCount)
        assertEquals("runs an older pi-mobile: update it there", c.notifyStatus["e1"])
        assertEquals(false, c.status()["on"].bool)
        // A push that fails says the computer's sentence.
        hubs["e1"] = Hub().apply { failPushes = 1 }
        c.reconcile()
        assertEquals("Your computer didn't answer in time.", c.notifyStatus["e1"])
    }

    @Test fun relayNotReadyIsEachComputersReason() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(501))
        val c = center()
        c.reconcile()
        assertEquals(0, c.notifyingCount)
        assertEquals("Notifications aren't available yet. Try again later.", c.notifyStatus["e1"])
    }

    @Test fun offTakesTheRelayBackFromEveryComputerUntilItLands() = runBlocking {
        caps("cap-1")
        val c = center()
        c.reconcile()
        hubs["e2"]!!.failPushes = 1 // asleep when the off goes out
        c.enable(false)
        assertEquals(obj("relay" to null), hubs["e1"]!!.pushes.last())
        assertTrue(hubs["e2"]!!.relayOn)
        assertEquals(emptyMap<String, String?>(), c.notifyStatus)
        c.reconcile()
        assertTrue(hubs["e2"]!!.pushes.last()["relay"].isNull)
        assertFalse(hubs["e2"]!!.relayOn)
        c.reconcile()
        assertEquals("already off: nothing more", 2, hubs["e1"]!!.pushes.size)
        assertEquals(2, hubs["e2"]!!.pushes.size)
    }

    @Test fun aBuildWithoutPushTakesBackWhatAnEarlierBuildLeft() = runBlocking {
        hubs["e1"]!!.relayOn = true
        val c = center(relay = false)
        c.reconcile()
        assertEquals(listOf(obj("relay" to null)), hubs["e1"]!!.pushes)
        assertEquals(emptyList<JsonObject>(), hubs["e2"]!!.pushes)
        assertEquals(obj("on" to false, "permission" to "granted", "available" to false, "computers" to emptyList<Any>()), c.status())
        assertEquals(
            "Notifications aren't available in this build of the app.",
            assertThrows(PushCenter.Failure::class.java) { runBlocking { c.enable(true) } }.message,
        )
        assertEquals(0, server.requestCount)
    }

    @Test fun enableRegistersAndReportsOn() = runBlocking {
        caps("cap-1")
        val c = center(on = false)
        prefs.pushToken = null
        val status = c.enable(true)
        assertEquals(true, status["on"].bool)
        assertTrue(prefs.notificationsOn)
        assertEquals(TOKEN, prefs.pushToken)
        assertEquals(listOf(sent("cap-1")), hubs["e1"]!!.pushes)
    }

    @Test fun enableFailsWithASentenceAndStaysOff() = runBlocking {
        val c = center(on = false)
        granted = false
        assertEquals("Notifications are off for pi. Turn them on in Settings.", enableError(c))
        assertEquals("denied", c.status()["permission"].string)
        granted = true
        fcmToken = null
        assertEquals("This phone can't get notifications right now (it needs Google Play services). Try again later.", enableError(c))
        fcmToken = TOKEN
        server.enqueue(MockResponse().setResponseCode(501))
        assertEquals("Notifications aren't available yet. Try again later.", enableError(c))
        // Turning on ignores the pause the 501 started.
        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals("Couldn't reach the notification relay. Try again later.", enableError(c))
        assertEquals(2, server.requestCount)
        caps("cap-1")
        hubs["e1"]!!.down = true
        hubs["e2"] = Hub(relay = false)
        assertEquals("No computer can notify this phone yet. box runs an older pi-mobile: update it there; mac isn't reachable right now.", enableError(c))
        machines = emptyList()
        assertEquals("Pair a computer first.", enableError(c))
        assertFalse(prefs.notificationsOn)
    }

    private fun enableError(c: PushCenter): String? {
        val e = assertThrows(PushCenter.Failure::class.java) { runBlocking { c.enable(true) } }
        assertFalse(prefs.notificationsOn)
        return e.message
    }

    @Test fun relayActionTable() {
        assertEquals(PushCenter.RelayStep(false, sentTo("c")), PushCenter.relayAction("u", "c", relayOn = false, sent = false))
        assertEquals(PushCenter.RelayStep(false, sentTo("c")), PushCenter.relayAction("u", "c", relayOn = true, sent = false))
        assertEquals(PushCenter.RelayStep(false, null), PushCenter.relayAction("u", "c", relayOn = true, sent = true))
        assertEquals(PushCenter.RelayStep(true, sentTo("c")), PushCenter.relayAction("u", "c", relayOn = false, sent = true))
        assertEquals(PushCenter.RelayStep(false, obj("relay" to null)), PushCenter.relayAction(null, "c", relayOn = true, sent = true))
        assertEquals(PushCenter.RelayStep(false, null), PushCenter.relayAction("u", null, relayOn = false, sent = false))
    }

    private fun sentTo(cap: String) = obj("relay" to obj("url" to "u", "cap" to cap))

    @Test fun permissionStates() {
        assertEquals("granted", NotificationPermission.state(notificationsEnabled = true, runtimePermission = false, asked = true))
        assertEquals("default", NotificationPermission.state(notificationsEnabled = false, runtimePermission = true, asked = false))
        assertEquals("denied", NotificationPermission.state(notificationsEnabled = false, runtimePermission = true, asked = true))
        assertEquals(
            "one no: Android 13+ still shows the dialog a second time",
            "default", NotificationPermission.state(notificationsEnabled = false, runtimePermission = true, asked = true, rationale = true),
        )
        assertEquals("pre-33: only the Settings switch", "denied", NotificationPermission.state(notificationsEnabled = false, runtimePermission = false, asked = false))
    }

    private companion object {
        const val TOKEN = "fcm-token-0123456789abcdef:APA91b"
    }
}
