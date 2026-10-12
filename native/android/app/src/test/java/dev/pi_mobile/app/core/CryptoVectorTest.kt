package dev.pi_mobile.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/** native/fixtures/crypto-vectors.json (made by tweetnacl-js, `npm run vectors`), byte for byte. */
class CryptoVectorTest {
    private val vectors = parseJson(File(System.getProperty("pi.repo"), "native/fixtures/crypto-vectors.json").readText())
    private val key = Base64Url.decode(vectors["key"].string!!)!!
    private val nonce = Base64Url.decode(vectors["nonce"].string!!)!!

    @Test fun sealsLikeTweetnacl() {
        val valid = vectors["valid"].array!!
        check(valid.isNotEmpty())
        for (v in valid) {
            val json = v["json"].string!!
            assertEquals(v["name"].string, v["sealed"].string, Envelope.seal(key, json.toByteArray(Charsets.UTF_8), nonce))
            assertEquals(json, Envelope.openData(key, v["sealed"].string!!)!!.toString(Charsets.UTF_8))
            assertEquals(v["value"], Envelope.open(key, v["sealed"].string!!))
        }
    }

    @Test fun rejectsInvalid() {
        val invalid = vectors["invalid"].array!!
        check(invalid.isNotEmpty())
        for (v in invalid) {
            val k = v["key"].string?.let { Base64Url.decode(it)!! } ?: key
            assertNull(v["name"].string, Envelope.openData(k, v["sealed"].string!!))
        }
    }

    @Test fun roundTripsWithRandomNonce() {
        val sealed = Envelope.seal(key, obj("t" to 1, "m" to "hub"))
        assertNotNull(Envelope.open(key, sealed))
        assertEquals("hub", Envelope.open(key, sealed)["m"].string)
    }
}
