package dev.pi_mobile.app.core

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import javax.crypto.KeyGenerator

/**
 * The encrypted store with a JCE AES-256-GCM key (AndroidKeyStore doesn't exist under Robolectric;
 * the store logic and the cipher code are the same), plus [MachineStore.adding].
 */
@RunWith(RobolectricTestRunner::class)
class MachineStoreTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("pi-secure-test", Context.MODE_PRIVATE)
    private val jceKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val store = EncryptedMachineStore(prefs, AesGcmCipher { jceKey })
    private val k = Base64Url.encode(ByteArray(32) { 3 })

    private fun m(id: String, d: String = "d-$id", machine: String = "", primary: Boolean = false) =
        Machine(id = id, machine = machine, name = id, origin = "https://$id.ts.net", d = d, k = k, primary = primary, added = 1.0)

    @Test fun roundTripsInOrderAndEncrypted() {
        assertEquals(emptyList<Machine>(), store.load())
        val list = listOf(m("a", primary = true), m("b"), m("c"))
        store.save(list)
        assertEquals(list, store.load())
        val raw = prefs.getString(EncryptedMachineStore.KEY, null)!!
        assertFalse("no plaintext at rest", k in raw || "ts.net" in raw)
        // A fresh instance over the same file reads it back (app restart).
        assertEquals(list, EncryptedMachineStore(prefs, AesGcmCipher { jceKey }).load())
    }

    @Test fun emptyListAndClearRemoveTheEntry() {
        store.save(listOf(m("a")))
        store.save(emptyList())
        assertFalse(prefs.contains(EncryptedMachineStore.KEY))
        store.save(listOf(m("a")))
        store.clear()
        assertEquals(emptyList<Machine>(), store.load())
    }

    @Test fun unreadableDataLoadsAsNothing() {
        store.save(listOf(m("a")))
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertEquals(emptyList<Machine>(), EncryptedMachineStore(prefs, AesGcmCipher { otherKey }).load())
        prefs.edit().putString(EncryptedMachineStore.KEY, "!!").commit()
        assertEquals(emptyList<Machine>(), store.load())
    }

    @Test fun aCipherFailureIsASaveFailure() {
        val broken = EncryptedMachineStore(prefs, object : SecretCipher {
            override fun encrypt(plain: ByteArray): ByteArray = error("keystore locked")
            override fun decrypt(sealed: ByteArray): ByteArray = error("keystore locked")
        })
        assertThrows(MachineStore.SaveFailed::class.java) { broken.save(listOf(m("a"))) }
        val mem = InMemoryMachineStore(listOf(m("a")), failSaves = true)
        assertThrows(MachineStore.SaveFailed::class.java) { mem.save(emptyList()) }
        assertEquals(listOf(m("a")), mem.load())
    }

    @Test fun pairingReplacesThePrimaryAndTheSameComputer() {
        val list = listOf(m("old", primary = true), m("box", machine = "m-box"), m("lan", d = "d-x"))
        val primary = MachineStore.adding(m("new", primary = true), list)
        assertEquals(listOf("new", "box", "lan"), primary.map { it.id })
        assertEquals(1, primary.count { it.primary })
        // Re-paired (same device id) or the same computer (same machine id): replaced, appended last.
        assertEquals(listOf("old", "box", "lan2"), MachineStore.adding(m("lan2", d = "d-x"), list).map { it.id })
        assertEquals(listOf("old", "lan", "box2"), MachineStore.adding(m("box2", machine = "m-box"), list).map { it.id })
        // An unknown machine id never matches other entries without one.
        assertEquals(listOf("old", "box", "lan", "y"), MachineStore.adding(m("y"), list).map { it.id })
    }
}
