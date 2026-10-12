package dev.pi_mobile.app.core

import java.io.ByteArrayOutputStream

/**
 * Incremental Server-Sent Events parser (WHATWG rules): CR, LF or CRLF line ends, `:` comments,
 * multi-line `data:` joined with "\n", one leading space stripped from values, dispatch on a blank line.
 * Fed byte by byte so chunk boundaries never matter (a UTF-8 sequence split across reads included).
 * Port of native/ios/Pi/Core/SSEParser.swift.
 */
class SseParser {
    sealed interface Item {
        data class Comment(val text: String) : Item
        data class Message(val event: String?, val data: String) : Item
    }

    private val line = ByteArrayOutputStream()
    private val data = mutableListOf<String>()
    private var event: String? = null
    private var afterCR = false

    fun feed(byte: Byte): Item? {
        if (afterCR) {
            afterCR = false
            if (byte == LF) return null // the LF of a CRLF
        }
        return when (byte) {
            CR -> { afterCR = true; endLine() }
            LF -> endLine()
            else -> { line.write(byte.toInt()); null }
        }
    }

    fun feed(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset): List<Item> =
        (offset until offset + length).mapNotNull { feed(bytes[it]) }

    private fun endLine(): Item? {
        val text = line.toString(Charsets.UTF_8.name())
        val empty = line.size() == 0
        line.reset()
        if (empty) {
            val out = if (data.isEmpty()) null else Item.Message(event, data.joinToString("\n"))
            data.clear()
            event = null
            return out
        }
        if (text.startsWith(":")) return Item.Comment(text.substring(1).removePrefix(" "))
        val colon = text.indexOf(':')
        val field = if (colon >= 0) text.substring(0, colon) else text
        val value = if (colon >= 0) text.substring(colon + 1).removePrefix(" ") else ""
        when (field) {
            "data" -> data.add(value)
            "event" -> event = value
            else -> {} // id, retry: the hub resumes with `since` instead
        }
        return null
    }

    private companion object {
        const val CR: Byte = 0x0D
        const val LF: Byte = 0x0A
    }
}
