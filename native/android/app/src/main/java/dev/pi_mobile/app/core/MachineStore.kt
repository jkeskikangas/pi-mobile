package dev.pi_mobile.app.core

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.serialization.builtins.ListSerializer
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The phone's computers, `[{ id, machine, name, origin, d, k, primary, added, lastSeen }]`
 * (plans/native-apps.md §1 "Machines"). The Keychain MachineStore of the iOS app (plans/native-android.md A6).
 * Android never had a single-device record, so there is nothing to migrate.
 */
interface MachineStore {
    /** The stored list in its stored order; empty when nothing is stored or it can't be read. */
    fun load(): List<Machine>

    /** Throws [SaveFailed] when the write didn't stick: callers must not report success (pairing codes are single use). */
    fun save(list: List<Machine>)

    fun clear()

    class SaveFailed(cause: Throwable? = null) : Exception("This phone couldn't save your computers. Try again.", cause)

    companion object {
        /**
         * [list] with a freshly paired computer: it replaces an entry for the same device or computer, and a
         * primary one replaces the old primary and goes first, as `web/app.js` does. Keeps exactly one primary.
         */
        fun adding(m: Machine, list: List<Machine>): List<Machine> {
            val out = list.filter { !(it.primary && m.primary) && it.d != m.d && !(m.machine != "" && it.machine == m.machine) }
            return if (m.primary) listOf(m) + out else out + m
        }
    }
}

/** Encrypts the machine list at rest. Separate so the store logic runs on the JVM without AndroidKeyStore. */
interface SecretCipher {
    fun encrypt(plain: ByteArray): ByteArray
    /** Throws when [sealed] is garbled or was sealed with another key. */
    fun decrypt(sealed: ByteArray): ByteArray
}

/**
 * AES-256-GCM, `iv12 ‖ ciphertext+tag`. The IV comes from the provider: AndroidKeyStore refuses
 * caller-chosen IVs for encryption, and letting it choose rules out reuse.
 */
class AesGcmCipher(private val key: () -> SecretKey) : SecretCipher {
    override fun encrypt(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        return c.iv + c.doFinal(plain)
    }

    override fun decrypt(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "too short" }
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return c.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/** The list as encrypted JSON under one key of a private [SharedPreferences] file. Writes `commit` (see [save]). */
@SuppressLint("ApplySharedPref")
open class EncryptedMachineStore(private val prefs: SharedPreferences, private val cipher: SecretCipher) : MachineStore {
    private val serializer = ListSerializer(Machine.serializer())

    override fun load(): List<Machine> {
        val stored = prefs.getString(KEY, null) ?: return emptyList()
        return try {
            PiJson.decodeFromString(serializer, cipher.decrypt(Base64.getDecoder().decode(stored)).toString(Charsets.UTF_8))
        } catch (_: Exception) {
            // Unreadable (e.g. the Keystore key was lost): the user pairs again.
            emptyList()
        }
    }

    // Not the KTX edit {}: it drops commit()'s result, and a failed write must be reported.
    @SuppressLint("UseKtx")
    override fun save(list: List<Machine>) {
        val ok = try {
            val edit = prefs.edit()
            if (list.isEmpty()) {
                edit.remove(KEY)
            } else {
                val sealed = cipher.encrypt(PiJson.encodeToString(serializer, list).toByteArray(Charsets.UTF_8))
                edit.putString(KEY, Base64.getEncoder().encodeToString(sealed))
            }
            // commit, not apply: success must mean written.
            edit.commit()
        } catch (e: Exception) {
            throw MachineStore.SaveFailed(e)
        }
        if (!ok) throw MachineStore.SaveFailed()
    }

    override fun clear() {
        prefs.edit(commit = true) { remove(KEY) }
    }

    companion object {
        const val KEY = "machines"
    }
}

/**
 * The production store: an AES-256 key in AndroidKeyStore (alias `pi-machines`, no user-authentication
 * requirement so voice keeps working on a locked screen) and the ciphertext in the private `pi-secure`
 * preferences file, which the backup rules exclude (a restored copy couldn't be decrypted anyway).
 */
class KeystoreMachineStore(context: Context) : EncryptedMachineStore(
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
    AesGcmCipher { keystoreKey() },
) {
    companion object {
        const val PREFS = "pi-secure"
        const val ALIAS = "pi-machines"

        private fun keystoreKey(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            gen.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return gen.generateKey()
        }
    }
}

/** For tests: holds the list in memory; [failSaves] makes [save] fail like a refused Keystore write. */
class InMemoryMachineStore(initial: List<Machine> = emptyList(), var failSaves: Boolean = false) : MachineStore {
    private var list = initial

    @Synchronized override fun load(): List<Machine> = list

    @Synchronized override fun save(list: List<Machine>) {
        if (failSaves) throw MachineStore.SaveFailed()
        this.list = list
    }

    @Synchronized override fun clear() {
        list = emptyList()
    }
}
