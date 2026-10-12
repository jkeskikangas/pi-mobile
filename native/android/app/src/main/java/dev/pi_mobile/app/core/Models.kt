package dev.pi_mobile.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.net.URI
import java.security.SecureRandom

/**
 * One computer this phone uses (plans/native-apps.md §1 "Machines"). Mirrors the entries
 * `web/fleet.js` keeps: [id] is this phone's own handle, [machine] the computer's id.
 * Port of native/ios/Pi/Core/Models.swift.
 */
@Serializable
data class Machine(
    val id: String = newId(),
    val machine: String = "",
    val name: String,
    val origin: String,
    val d: String,
    val k: String,
    val primary: Boolean = false,
    val added: Double = System.currentTimeMillis().toDouble(),
    val lastSeen: Double = 0.0,
) {
    val key: ByteArray? get() = Base64Url.decode(k)

    /** What `web/fleet.js` stores under `pi-mobile-machines` (the primary is reached at the page origin). */
    val webEntry: JsonObject
        get() {
            val o = mutableMapOf<String, Any?>(
                "id" to id, "machine" to machine, "name" to name, "d" to d, "k" to k, "added" to added, "lastSeen" to lastSeen,
            )
            if (primary) o["primary"] = true else o["origin"] = origin
            return jsonOf(o) as JsonObject
        }

    /** The single-device record `web/app.js` reads under `pi-mobile-device`. */
    val webDevice: JsonObject get() = obj("d" to d, "k" to k, "role" to "control", "host" to name)

    companion object {
        private val random = SecureRandom()
        fun newId(): String = ByteArray(6).also { random.nextBytes(it) }.let { Base64Url.encode(it) }
    }
}

/** `<origin>/#p=<pairingId>.<base64url key>` from `/remote`. */
data class PairingLink(val origin: String, val id: String, val key: ByteArray) {
    override fun equals(other: Any?) = other is PairingLink && other.origin == origin && other.id == id && other.key.contentEquals(key)
    override fun hashCode() = origin.hashCode() * 31 + id.hashCode()

    companion object {
        private val FRAGMENT = Regex("(?:^|&)p=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)")

        /** null when `text` isn't a pairing link. */
        fun parse(text: String): PairingLink? {
            val uri = try { URI(text.trim()) } catch (_: Exception) { return null }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host ?: return null
            val fragment = uri.rawFragment ?: return null
            val m = FRAGMENT.find(fragment) ?: return null
            val key = Base64Url.decode(m.groupValues[2]) ?: return null
            if (key.size != Envelope.KEY_BYTES) return null
            val bareHost = host.trim('[', ']')
            var origin = "$scheme://" + (if (bareHost.contains(":")) "[$bareHost]" else bareHost)
            if (uri.port != -1) origin += ":${uri.port}"
            origin += (uri.rawPath ?: "").trimEnd('/')
            return PairingLink(origin, m.groupValues[1], key)
        }
    }
}

/** A pi session as the hub reports it (`src/protocol.ts` AgentInfo); only the fields the app reads. */
data class AgentInfo(val id: String, val name: String?, val cwd: String?, val status: String?) {
    companion object {
        fun from(raw: JsonElement?): AgentInfo? {
            val id = raw["id"].string ?: return null
            return AgentInfo(id, raw["name"].string, raw["cwd"].string, raw["status"].string)
        }
    }
}

/** `hub` RPC result. */
data class HubInfo(val raw: JsonElement) {
    val hubId: String get() = raw["hubId"].string ?: ""
    val host: String get() = raw["host"].string ?: ""
    val seq: Int get() = raw["seq"].int ?: 0
    val protocolVersion: Int? get() = raw["protocol"].int
    val features: List<String> get() = raw["features"].array?.mapNotNull { it.string } ?: emptyList()
    val agents: List<JsonElement> get() = raw["agents"].array ?: emptyList()
}

/**
 * One event from `/api/stream` (`src/hub.ts` HubEvent / `src/protocol.ts` AgentEvent).
 * Kept as raw JSON: the web UI renders sessions; native code reads only a few fields.
 */
data class HubEvent(val raw: JsonElement) {
    val type: String get() = raw["type"].string ?: ""
    val agent: String? get() = raw["agent"].string
    val seq: Int? get() = raw["seq"].int
}

enum class ConnectionState { CONNECTING, ONLINE, OFFLINE }

/** Errors from a computer; [message] is a sentence the UI shows as is. */
sealed class HubError(message: String) : Exception(message) {
    /** 401: this phone was removed from that computer. */
    object Unauthorized : HubError("This phone was removed from that computer.")
    /** 410 on pairing: the code was used or is older than 10 minutes. */
    object Expired : HubError("That code was already used or has expired.")
    /** The hub answered with an error message. */
    class Remote(message: String) : HubError(message)
    /** Could not reach the computer, or it answered garbage. */
    class Network(message: String) : HubError(message)
}
