package dev.pi_mobile.app.shell

import dev.pi_mobile.app.app.AppModel
import dev.pi_mobile.app.app.fromWeb
import dev.pi_mobile.app.consent.AIConsent
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.array
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.string
import dev.pi_mobile.app.dictation.Dictation
import dev.pi_mobile.app.push.PushController
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.util.Base64

/** Where a message came from, as the WebView's message listener reports it. */
data class FrameInfo(val isMainFrame: Boolean, val origin: String)

/** The answer to one `postMessage`: resolves the page's promise with [Value] or rejects it with [Error]'s text. */
sealed interface Reply {
    data class Value(val value: JsonElement) : Reply
    data class Error(val message: String) : Reply
}

/**
 * The page → native half of native/ios/BRIDGE.md, free of WebView so it runs as a JVM test. Every message type is
 * handled here; the features behind them come in through the interfaces in BridgePorts.kt. Port of
 * native/ios/Pi/Shell/NativeBridge.swift.
 *
 * @param primaryOrigin the paired primary computer's origin (as stored, possibly with a path): the page's own
 *   origin, the only one trusted, and the origin of the list entry marked primary.
 */
class NativeBridge(
    private val model: AppModel,
    private val primaryOrigin: String,
    private val dictation: Dictation,
    private val voice: VoiceStarter,
    private val push: PushController,
    private val consent: AIConsent,
    private val scanner: Scanner,
) {
    suspend fun handle(msg: JsonObject, frame: FrameInfo): Reply {
        // BRIDGE.md → Trust: the main frame of the page we loaded, nothing else.
        if (!frame.isMainFrame || !sameOrigin(frame.origin, primaryOrigin)) return Reply.Error(NOT_ALLOWED)
        return try {
            Reply.Value(dispatch(msg))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Reply.Error(e.message ?: "Something went wrong.")
        }
    }

    private suspend fun dispatch(msg: JsonObject): JsonElement = when (msg["type"].string) {
        "prefs" -> {
            val key = msg["key"].string ?: throw BridgeError("missing key")
            model.prefs.setVoice(key, msg["value"].string)
            JsonNull
        }
        "machines" -> {
            val list = msg["machines"].array.orEmpty().mapNotNull { Machine.fromWeb(it, primaryOrigin) }
            model.webMachines(list)
            JsonNull
        }
        "unpaired" -> {
            model.webUnpaired()
            JsonNull
        }
        "focus" -> {
            msg["agent"].string?.takeIf { it.isNotEmpty() }?.let { model.setFocus(it, msg["machine"].string ?: "", msg["name"].string ?: "") }
            JsonNull
        }
        "voice.start" -> {
            val agent = msg["agent"].string?.takeIf { it.isNotEmpty() } ?: throw BridgeError("Open a session first.")
            val machine = msg["machine"].string?.takeIf { it.isNotEmpty() } ?: model.primary?.id ?: ""
            // The web already dropped its recording UI and won't send dictation.cancel.
            dictation.cancelIfActive()
            voice.start(agent, machine)
            JsonNull
        }
        "dictation.start" -> {
            dictation.start()
            JsonNull
        }
        "dictation.stop" -> {
            val audio = dictation.stop()
            obj("audio" to Base64.getEncoder().encodeToString(audio), "mime" to MIME)
        }
        "dictation.cancel" -> {
            dictation.cancel()
            JsonNull
        }
        "push.status" -> push.status()
        "push.enable" -> push.enable(msg["on"].bool ?: true)
        "scan" -> obj("link" to scanner.scan())
        "consent.status" -> obj("granted" to consent.granted)
        "consent.revoke" -> {
            consent.revoke()
            dictation.consentRevoked()
            voice.stop()
            obj("granted" to false)
        }
        else -> throw BridgeError("unknown message")
    }

    companion object {
        const val NOT_ALLOWED = "not allowed"

        /** Dictation audio: AAC in MPEG-4 (AudioRecorder). */
        const val MIME = "audio/mp4"

        /** Same scheme, host and port (a stored origin may carry a path; the frame's never does). */
        fun sameOrigin(a: String, b: String): Boolean {
            val x = a.toHttpUrlOrNull() ?: return false
            val y = b.toHttpUrlOrNull() ?: return false
            return x.scheme == y.scheme && x.host == y.host && x.port == y.port
        }

        /** `scheme://host[:port]` of [url], the form WebView origin rules take; null when it isn't an http(s) URL. */
        fun originRule(url: String): String? {
            val u = url.toHttpUrlOrNull() ?: return null
            val host = if (u.host.contains(':')) "[${u.host}]" else u.host
            val port = if (u.port == okhttp3.HttpUrl.defaultPort(u.scheme)) "" else ":${u.port}"
            return "${u.scheme}://$host$port"
        }
    }
}
