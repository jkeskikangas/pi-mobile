package dev.pi_mobile.app.core

import dev.pi_mobile.app.core.SseParser.Item
import org.junit.Assert.assertEquals
import org.junit.Test

/** Port of native/ios/PiTests/SSEParserTests.swift. */
class SseParserTest {
    private fun parse(vararg chunks: String): List<Item> {
        val p = SseParser()
        return chunks.flatMap { p.feed(it.toByteArray()) }
    }

    @Test fun messagesAndComments() {
        assertEquals(listOf(Item.Comment("ping"), Item.Message(null, "abc")), parse(": ping\n\ndata: abc\n\n"))
    }

    @Test fun chunkBoundariesAnywhere() {
        val text = "event: x\ndata: hellö\n\n: ping\n\ndata: world\n\n"
        val bytes = text.toByteArray()
        val whole = parse(text)
        for (split in 1 until bytes.size) {
            val p = SseParser()
            val out = p.feed(bytes, 0, split) + p.feed(bytes, split)
            assertEquals("split at $split", whole, out)
        }
        assertEquals(listOf(Item.Message("x", "hellö"), Item.Comment("ping"), Item.Message(null, "world")), whole)
    }

    @Test fun multiLineDataAndLineEndings() {
        assertEquals(listOf(Item.Message(null, "a\nb")), parse("data: a\r\ndata:b\r\n\r\n"))
        assertEquals(listOf(Item.Message(null, "a")), parse("data: a\r", "\r"))
    }

    @Test fun ignoresUnknownFieldsAndEmptyEvents() {
        assertEquals(listOf(Item.Message(null, "")), parse("id: 4\nretry: 10\n\n\n\ndata\n\n"))
    }

    @Test fun incompleteMessageIsNotDispatched() {
        assertEquals(emptyList<Item>(), parse("data: partial\n"))
    }
}
