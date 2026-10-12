package dev.pi_mobile.app.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** `PairingLink.parse`, the cases of HubClientTests.testPairingLinkParsing (Swift) plus IPv6 and trailing slashes. */
class PairingLinkTest {
    private val pairKey = ByteArray(32) { (200 - it).toByte() }
    private val k = Base64Url.encode(pairKey)

    @Test fun parsesTheLinkFromRemote() {
        val l = PairingLink.parse("  http://192.168.1.4:7979/#p=abc_-1.$k\n")!!
        assertEquals("http://192.168.1.4:7979", l.origin)
        assertEquals("abc_-1", l.id)
        assertArrayEquals(pairKey, l.key)
    }

    @Test fun keepsAPathPrefixAndFindsPAmongOtherFragmentParts() {
        assertEquals("https://mac.tail1.ts.net/pi", PairingLink.parse("https://mac.tail1.ts.net/pi/#x=1&p=id.$k")?.origin)
        assertEquals("https://mac.tail1.ts.net/pi", PairingLink.parse("https://mac.tail1.ts.net/pi//#p=id.$k")?.origin)
        assertEquals("http://[::1]:7979", PairingLink.parse("http://[::1]:7979/#p=id.$k")?.origin)
    }

    @Test fun rejectsWhatIsNotAPairingLink() {
        assertNull(PairingLink.parse("http://h/#p=id.short"))
        assertNull(PairingLink.parse("ftp://h/#p=id.$k"))
        assertNull(PairingLink.parse("hello"))
        assertNull(PairingLink.parse("https://h/"))
    }
}
