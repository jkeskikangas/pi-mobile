package dev.pi_mobile.app.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Regression for the reported failure: pairing with a ts.net address was rejected as not a valid URL.
class PairingLinkFormsTest {
    private val pairKey = ByteArray(32) { (200 - it).toByte() }
    private val k = Base64Url.encode(pairKey)
    private val host = "first-gen-3.tail3b3137.ts.net"

    private fun machine() = Machine(origin = "https://$host", name = "first-gen-3", d = "d", k = k)

    @Test fun fullPairingLinkWithExactHost() {
        val full = "https://$host/#p=abc123.$k"
        val l = PairingLink.parse(full)
        assertNotNull("pairing link '$full' must parse", l)
        assertEquals("https://$host", l!!.origin)
        assertEquals("abc123", l.id)
        assertArrayEquals(pairKey, l.key)
    }

    @Test fun bareAddressIsNotALinkButIsAnAddress() {
        for (bare in listOf("https://$host", "https://$host/", "https://$host/pi", " https://$host ")) {
            assertNull("'$bare' has no pairing code", PairingLink.parse(bare))
            assertTrue("'$bare' is still an address", PairingLink.addressOnly(bare))
        }
    }

    @Test fun parseDeepFindsLinkInsideRemoteLine() {
        val line = "tailscale https: https://$host/#p=abc123.$k"
        val l = PairingLink.parseDeep(line)
        assertNotNull("whole /remote line must yield the link", l)
        assertEquals("https://$host", l!!.origin)
        assertEquals("abc123", l.id)
    }

    @Test fun garbageIsNeither() {
        assertNull(PairingLink.parse("hello"))
        assertFalse(PairingLink.addressOnly("hello"))
        assertFalse(PairingLink.addressOnly(""))
        assertFalse(PairingLink.addressOnly("https://$host/#p=abc123.$k"))
    }

    @Test fun originPolicyAcceptsExactHost() {
        assertNull(OriginPolicy.problem("https://$host"))
        assertNull(OriginPolicy.problem("https://$host/"))
    }

    @Test fun okhttpPathBuildersAcceptExactHost() {
        val m = machine()
        assertNotNull("${m.origin}/api/stream".toHttpUrlOrNull())
        assertEquals("https://$host/api/rpc", "${m.origin}/api/rpc".toHttpUrlOrNull().toString())
    }
}