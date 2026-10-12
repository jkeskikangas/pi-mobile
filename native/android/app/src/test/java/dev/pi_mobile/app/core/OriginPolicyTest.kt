package dev.pi_mobile.app.core

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** HTTPS only, plus plain-HTTP loopback for the emulator. Port of native/ios/PiTests/OriginPolicyTests.swift. */
class OriginPolicyTest {
    @Test fun httpsOnlyExceptLoopback() {
        for (ok in listOf("https://box.tail1234.ts.net", "https://example.com:8443", "https://100.101.1.2:7777",
            "http://127.0.0.1:7989", "http://localhost:1", "http://[::1]:7")) {
            assertNull(ok, OriginPolicy.problem(ok))
        }
        for (bad in listOf("http://example.com", "http://box.tail1234.ts.net", "http://10.0.0.2:7777", "http://192.168.1.20:7777",
            "http://100.101.1.2:7777", "http://mac.local:7777", "http://box:7", "http://[fe80::1]:7")) {
            assertEquals(bad, OriginPolicy.PLAIN_HTTP_MESSAGE, OriginPolicy.problem(bad))
        }
        assertNotNull(OriginPolicy.problem("ftp://box"))
        assertNotNull(OriginPolicy.problem("not a url"))
        assertTrue("says phone, not iPhone", "this phone" in OriginPolicy.PLAIN_HTTP_MESSAGE)
    }

    @Test fun redirectsStayOnTheSameSecureOrigin() {
        val from = "https://box.tail1.ts.net/api/rpc".toHttpUrl()
        fun allows(to: String) = OriginPolicy.allowsRedirect(from, to.toHttpUrl())
        assertTrue(allows("https://box.tail1.ts.net/api/rpc2"))
        assertFalse(allows("http://box.tail1.ts.net/api/rpc"))
        assertFalse(allows("http://mac.local/api/rpc"))
        assertFalse(allows("http://box/api/rpc"))
        assertFalse(allows("https://evil.example/api/rpc"))
        assertFalse(allows("https://box.tail1.ts.net:8443/api/rpc"))
        assertFalse(OriginPolicy.allowsRedirect(from, null))
    }

    @Test fun pairingAndClientsRefusePlainHttp(): Unit = runBlocking {
        val link = PairingLink.parse("http://192.168.1.20:7777/#p=abc." + Base64Url.encode(ByteArray(32) { 1 }))!!
        val e = runCatching { HubClient.pair(link, "phone") }.exceptionOrNull()
        assertTrue(e is HubError.Remote)
        assertEquals(OriginPolicy.PLAIN_HTTP_MESSAGE, e!!.message)
        val m = Machine(name = "x", origin = "http://192.168.1.20:7777", d = "d", k = Base64Url.encode(ByteArray(32) { 3 }))
        assertThrows(HubError.Remote::class.java) { HubClient(m) }
    }
}
