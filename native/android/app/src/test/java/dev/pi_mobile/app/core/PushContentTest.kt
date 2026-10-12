package dev.pi_mobile.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Opening the relay's sealed push, with the key from crypto-vectors.json. Port of the PushContent parts of PushTests.swift. */
class PushContentTest {
    private val k = parseJson(File(System.getProperty("pi.repo"), "native/fixtures/crypto-vectors.json").readText())["key"].string!!
    private val machines = listOf(
        Machine(id = "e-other", machine = "m-other", name = "box", origin = "https://box.ts.net", d = "d2", k = Base64Url.encode(ByteArray(32) { 9 }), primary = true),
        Machine(id = "e-mac", machine = "m-mac", name = "mac", origin = "https://mac.ts.net", d = "d1", k = k),
    )

    private fun seal(vararg pairs: Pair<String, Any?>) = Envelope.seal(Base64Url.decode(k)!!, obj(*pairs))

    @Test fun showsTitleAndBodyOpenedWithTheMachinesKey() {
        val sealed = seal("title" to "pi-mobile asks", "body" to "Run the migration?", "agent" to "a1", "machine" to "m-mac")
        val out = PushContent.shown(mapOf("sealed" to sealed, "urgent" to "1"), machines)
        assertEquals("pi-mobile asks", out.title)
        assertEquals("Run the migration?", out.body)
        assertEquals(PushContent.Opened("pi-mobile asks", "Run the migration?", "a1", "m-mac", "e-mac"), out.opened)
        assertEquals("m-mac:a1", out.group)
        assertTrue(out.asks)
    }

    @Test fun notUrgentHasNoVoiceAction() {
        val sealed = seal("title" to "pi-mobile", "body" to "Done", "agent" to "a1", "machine" to "m-mac")
        val out = PushContent.shown(mapOf("sealed" to sealed), machines)
        assertEquals("Done", out.body)
        assertFalse(out.asks)
    }

    @Test fun prefersTheEntryNamingTheSendingComputer() {
        val twin = machines + Machine(id = "e-mac-2", machine = "m-mac-2", name = "mac", origin = "https://mac2.ts.net", d = "d3", k = k)
        val sealed = seal("title" to "t", "agent" to "a1", "machine" to "m-mac-2")
        assertEquals("e-mac-2", PushContent.open(sealed, twin)?.entry)
        // No machine in the payload: the entry whose key opened it.
        assertEquals(PushContent.Opened("pi", "", "", "m-mac", "e-mac"), PushContent.open(seal("x" to 1), machines))
    }

    @Test fun keepsGenericTextWhenNoKeyOpensIt() {
        val sealed = seal("title" to "secret", "body" to "secret", "agent" to "a1")
        for (list in listOf(emptyList(), machines.take(1))) {
            val out = PushContent.shown(mapOf("sealed" to sealed, "urgent" to "1"), list)
            assertEquals(PushContent.Shown("pi", "New activity", null, null, false), out)
        }
        assertEquals("New activity", PushContent.shown(mapOf("sealed" to "nope"), machines).body)
        assertEquals("New activity", PushContent.shown(emptyMap(), machines).body)
        assertNull(PushContent.open(Envelope.seal(Base64Url.decode(k)!!, jsonOf(listOf(1))), machines))
    }
}
