package dev.pi_mobile.app.voice

import android.media.AudioDeviceInfo
import android.net.NetworkCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** The pure parts of the platform audio: route choice, display levels, earcon rendering. */
class VoicePlatformTest {
    @Test fun routePrefersAHeadsetThenTheSpeakerNeverTheEarpiece() {
        val bt = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
        val wired = AudioDeviceInfo.TYPE_WIRED_HEADSET
        val speaker = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        val earpiece = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        assertEquals(bt, AudioRoutes.pick(listOf(earpiece, speaker, wired, bt)) { it })
        assertEquals(wired, AudioRoutes.pick(listOf(earpiece, speaker, wired)) { it })
        assertEquals(AudioDeviceInfo.TYPE_USB_HEADSET, AudioRoutes.pick(listOf(speaker, AudioDeviceInfo.TYPE_USB_HEADSET)) { it })
        assertEquals(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioRoutes.pick(listOf(wired, AudioDeviceInfo.TYPE_BLE_HEADSET)) { it })
        // A headset gone: back to the speaker, not the earpiece.
        assertEquals(speaker, AudioRoutes.pick(listOf(earpiece, speaker)) { it })
        assertNull(AudioRoutes.pick(listOf(earpiece, AudioDeviceInfo.TYPE_TELEPHONY)) { it })
    }

    @Test fun routeNames() {
        assertEquals("Speaker", AudioRoutes.name(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "Pixel 9"))
        assertEquals("Pixel Buds", AudioRoutes.name(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, "Pixel Buds"))
        assertEquals("Bluetooth", AudioRoutes.name(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, " "))
        assertEquals("Headset", AudioRoutes.name(AudioDeviceInfo.TYPE_WIRED_HEADSET, null))
    }

    @Test fun levelsScaleAndSmooth() {
        assertEquals(0.0, Levels.scale(0.0), 0.0)
        assertEquals(0.0, Levels.scale(Double.NaN), 0.0)
        assertEquals(1.0, Levels.scale(0.9), 0.0)
        assertEquals(0.16, Levels.scale(0.01), 1e-9)
        val l = Levels()
        l.update(0.01, null)
        assertEquals(0.01, l.micRaw, 0.0)
        assertEquals(0.064, l.mic, 1e-9)
        assertEquals(0.0, l.pi, 0.0)
        l.update(null, 0.25)
        assertEquals(0.01, l.micRaw, 0.0)
        assertEquals(0.32, l.pi, 1e-9)
        l.reset()
        assertEquals(0.0, l.mic + l.pi + l.micRaw, 0.0)
    }

    @Test fun onlyADifferentKindOfNetworkCounts() {
        val wifi = NetworkKinds.kind { it == NetworkCapabilities.TRANSPORT_WIFI }
        val cellular = NetworkKinds.kind { it == NetworkCapabilities.TRANSPORT_CELLULAR }
        val vpnOverWifi = NetworkKinds.kind { it == NetworkCapabilities.TRANSPORT_WIFI || it == NetworkCapabilities.TRANSPORT_VPN }
        assertEquals(listOf("wifi", "cellular", "wifi"), listOf(wifi, cellular, vpnOverWifi))
        assertFalse(NetworkKinds.changed(null, wifi)) // the first network
        assertFalse(NetworkKinds.changed(wifi, vpnOverWifi)) // another Wi-Fi, a VPN, new capabilities
        assertTrue(NetworkKinds.changed(wifi, cellular))
        assertEquals("other", NetworkKinds.kind { false })
    }

    @Test fun earconsQueueInsteadOfCuttingEachOtherOff() {
        val clock = ManualScheduler()
        val started = mutableListOf<Pair<String, Double>>()
        val q = Earcons.EarconQueue(clock, { if (it == "long") 0.3 else 0.1 }) { started.add(it to clock.t) }
        q.play("long")
        q.play("a")
        q.play("b")
        assertEquals(listOf("long" to 0.0), started)
        clock.advance(0.3)
        assertEquals(listOf("long", "a"), started.map { it.first })
        clock.advance(0.2)
        assertEquals(listOf("long" to 0.0, "a" to 0.3, "b" to 0.4), started.map { it.first to Math.round(it.second * 10) / 10.0 })
        q.play("c")
        q.clear()
        q.play("d")
        assertEquals("d", started.last().first) // stop() forgets what was waiting
    }

    @Test fun earconsRenderStepsWithFades() {
        val pcm = Earcons.render(listOf(listOf(880.0, 70.0, 0.18), listOf(0.0, 10.0)), 48_000)
        assertEquals(3360 + 480, pcm.size)
        assertEquals(0, pcm[0].toInt()) // faded in
        val peak = pcm.take(3360).maxOf { abs(it.toInt()) }
        assertTrue(peak in 5500..5900) // 0.18 of full scale
        assertTrue(pcm.drop(3360).all { it.toInt() == 0 }) // the silent step
        assertEquals(0, Earcons.render(emptyList()).size)
    }
}
