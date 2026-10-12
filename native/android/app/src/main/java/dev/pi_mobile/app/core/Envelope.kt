package dev.pi_mobile.app.core

import kotlinx.serialization.json.JsonElement
import org.bouncycastle.crypto.engines.XSalsa20Engine
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** base64url without padding, as `Buffer.toString("base64url")` writes it. */
object Base64Url {
    private val ALPHABET = Regex("^[A-Za-z0-9_-]*$")

    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** null when `text` isn't base64url (padding is not accepted, like the Swift app). */
    fun decode(text: String): ByteArray? {
        if (!ALPHABET.matches(text) || text.length % 4 == 1) return null
        return try { Base64.getUrlDecoder().decode(text) } catch (_: IllegalArgumentException) { null }
    }
}

/**
 * The end-to-end envelope shared with `src/crypto.ts`: NaCl secretbox (XSalsa20-Poly1305),
 * `base64url(nonce24 ‖ box)` where `box = tag16 ‖ ciphertext`. Port of native/ios/Pi/Core/Envelope.swift;
 * checked byte for byte against native/fixtures/crypto-vectors.json (tweetnacl-js).
 */
object Envelope {
    const val KEY_BYTES = 32
    const val NONCE_BYTES = 24
    const val OVERHEAD = 16
    private val random = SecureRandom()

    /** Seals raw UTF-8 JSON text. `nonce` is for test vectors only: never reuse one in real traffic. */
    fun seal(key: ByteArray, plaintext: ByteArray, nonce: ByteArray? = null): String {
        require(key.size == KEY_BYTES) { "secretbox key must be 32 bytes" }
        val n = nonce ?: ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
        require(n.size == NONCE_BYTES)
        val box = secretbox(key, n, plaintext)
        return Base64Url.encode(n + box)
    }

    fun seal(key: ByteArray, value: JsonElement): String = seal(key, value.encode().toByteArray(Charsets.UTF_8))

    /** The plaintext, or null when forged, garbled or sealed with another key. */
    fun openData(key: ByteArray, sealed: String): ByteArray? {
        if (key.size != KEY_BYTES) return null
        val raw = Base64Url.decode(sealed) ?: return null
        if (raw.size <= NONCE_BYTES + OVERHEAD) return null
        return secretboxOpen(key, raw.copyOfRange(0, NONCE_BYTES), raw.copyOfRange(NONCE_BYTES, raw.size))
    }

    fun open(key: ByteArray, sealed: String): JsonElement? {
        val data = openData(key, sealed) ?: return null
        return try { parseJson(data.toString(Charsets.UTF_8)) } catch (_: Exception) { null }
    }

    // NaCl crypto_secretbox: the first 32 bytes of the XSalsa20 keystream are the Poly1305 key;
    // the message is XORed with the keystream from byte 32 on.
    private fun stream(key: ByteArray, nonce: ByteArray): XSalsa20Engine =
        XSalsa20Engine().apply { init(true, ParametersWithIV(KeyParameter(key), nonce)) }

    private fun tag(polyKey: ByteArray, ciphertext: ByteArray): ByteArray {
        val mac = Poly1305()
        mac.init(KeyParameter(polyKey))
        mac.update(ciphertext, 0, ciphertext.size)
        return ByteArray(16).also { mac.doFinal(it, 0) }
    }

    private fun secretbox(key: ByteArray, nonce: ByteArray, message: ByteArray): ByteArray {
        val s = stream(key, nonce)
        val polyKey = ByteArray(32)
        s.processBytes(ByteArray(32), 0, 32, polyKey, 0)
        val c = ByteArray(message.size)
        s.processBytes(message, 0, message.size, c, 0)
        return tag(polyKey, c) + c
    }

    private fun secretboxOpen(key: ByteArray, nonce: ByteArray, box: ByteArray): ByteArray? {
        val s = stream(key, nonce)
        val polyKey = ByteArray(32)
        s.processBytes(ByteArray(32), 0, 32, polyKey, 0)
        val c = box.copyOfRange(OVERHEAD, box.size)
        if (!MessageDigest.isEqual(tag(polyKey, c), box.copyOfRange(0, OVERHEAD))) return null
        val m = ByteArray(c.size)
        s.processBytes(c, 0, c.size, m, 0)
        return m
    }
}
