package dev.pi_mobile.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * JSON values that go into and come out of sealed envelopes, the bridge and the realtime data channel.
 * The app uses kotlinx.serialization's [JsonElement] tree directly (the Swift app's `JSON` enum);
 * these helpers read it the way the Swift code does (`raw["type"]?.string`).
 */
val PiJson: Json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

fun parseJson(text: String): JsonElement = PiJson.parseToJsonElement(text)

fun JsonElement.encode(): String = PiJson.encodeToString(JsonElement.serializer(), this)

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

operator fun JsonElement?.get(index: Int): JsonElement? = (this as? JsonArray)?.getOrNull(index)

/** The string value (not the JSON text) when this is a JSON string. */
val JsonElement?.string: String? get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

val JsonElement?.double: Double? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

val JsonElement?.int: Int? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull?.toInt() ?: it.doubleOrNull?.toInt() }

val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

val JsonElement?.array: List<JsonElement>? get() = this as? JsonArray

val JsonElement?.obj: JsonObject? get() = this as? JsonObject

val JsonElement?.isNull: Boolean get() = this == null || this is JsonNull

/** Builds a JSON value from plain Kotlin values (String, Number, Boolean, null, Map, List, JsonElement). */
fun jsonOf(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Int -> JsonPrimitive(value)
    is Long -> JsonPrimitive(value)
    is Double -> if (value % 1.0 == 0.0 && kotlin.math.abs(value) < 9.0e15) JsonPrimitive(value.toLong()) else JsonPrimitive(value)
    is Float -> jsonOf(value.toDouble())
    is Number -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to jsonOf(v) })
    is Iterable<*> -> JsonArray(value.map { jsonOf(it) })
    is Array<*> -> JsonArray(value.map { jsonOf(it) })
    else -> JsonPrimitive(value.toString())
}

/** `obj("type" to "x", "n" to 1)`: a JSON object from pairs; null values are kept as JSON null. */
fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to jsonOf(v) })

val EmptyObject: JsonObject = JsonObject(emptyMap())

/** A copy of this object with `key` set (or removed when `value` is null and `drop` is true). */
fun JsonObject.with(key: String, value: Any?): JsonObject = JsonObject(this + (key to jsonOf(value)))
