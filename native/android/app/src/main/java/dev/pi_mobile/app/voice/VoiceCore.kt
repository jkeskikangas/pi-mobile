package dev.pi_mobile.app.voice

import android.content.Context
import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.evaluate
import dev.pi_mobile.app.core.array
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.double
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.int
import dev.pi_mobile.app.core.jsonOf
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.Closeable
import java.util.concurrent.Executors

/**
 * `web/voice-core.js` evaluated in QuickJS (plans/native-android.md A10, plans/native-apps.md D3): every
 * decision voice mode delegates to `PiVoiceCore` goes through here, never reimplemented in Kotlin. Only
 * the copy bundled at build time runs (no downloaded code; the `bundleVoiceCore` task copies it from
 * `web/` into the assets); the hub's protocol and feature flags keep an older app compatible with a
 * newer computer. Port of native/ios/Pi/Voice/VoiceCore.swift.
 *
 * The engine calls these synchronously, as iOS calls its JSContext. quickjs-kt only offers a suspending
 * `evaluate`, so the runtime lives on its own thread and each call blocks the caller until it returns
 * (a few microseconds of pure JS: no I/O, no promises). Values cross as JSON text, so the bridge has one
 * shape for every function.
 */
class VoiceCore(script: String, val source: String) : Closeable {
    data class Command(val kind: String)

    /** `answerFor` result: [answered] (then [value]; null [value] = cancel), or [needConfirm], or [unclear]. */
    data class Answer(
        val answered: Boolean = false,
        val value: JsonElement? = null,
        val needConfirm: String? = null,
        val option: String? = null,
        val unclear: Boolean = false,
    )

    sealed interface Match {
        data class One(val index: Int) : Match
        data class Ambiguous(val indices: List<Int>) : Match
        data object None : Match
    }

    class LoadException(message: String) : Exception("voice-core.js: $message")

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "voice-core").apply { isDaemon = true } }
    private val thread = executor.asCoroutineDispatcher()
    private val js: QuickJs

    val help: String
    val settings: List<String>
    /** name → [[hz, ms, gain]] */
    val earcons: Map<String, List<List<Double>>>

    init {
        js = runBlocking(thread) { QuickJs.create(thread) }
        val loaded = try {
            runBlocking(thread) { js.evaluate<Any?>("$script\n$PRELUDE\nvoid 0;") }
            eval("({ help: PiVoiceCore.HELP, settings: PiVoiceCore.SETTINGS, earcons: PiVoiceCore.EARCONS })")
        } catch (e: Exception) {
            close()
            throw LoadException(e.message ?: "PiVoiceCore missing")
        }
        help = loaded["help"].string ?: ""
        settings = loaded["settings"].array?.mapNotNull { it.string } ?: emptyList()
        earcons = loaded["earcons"].obj?.mapValues { (_, steps) ->
            steps.array.orEmpty().map { step -> step.array.orEmpty().mapNotNull { it.double } }
        } ?: emptyMap()
    }

    override fun close() {
        if (!js.isClosed) runBlocking(thread) { js.close() }
        executor.shutdown()
    }

    /** Evaluates the JS expression `expr`; its value comes back through JSON (undefined → null). */
    private fun eval(expr: String): JsonElement? {
        val text = runBlocking(thread) { js.evaluate<String?>("__pi.json($expr)") }
        return text?.let(::parseJson)
    }

    private fun call(name: String, vararg args: Any?): JsonElement? =
        eval("__pi.call(${quote(name)}, ${JsonArray(args.map(::jsonOf)).encode()})")

    // PiVoiceCore
    fun norm(s: String): String = call("norm", s).string ?: ""

    fun parseCommand(text: String): Command? = call("parseCommand", text)["kind"].string?.let(::Command)

    fun answerFor(prompt: JsonElement, text: String): Answer {
        // `{ value: undefined }` (cancel) has the key; `{ needConfirm }` does not: the prelude says which.
        val r = eval("__pi.answerFor(${prompt.encode()}, ${quote(text)})") as? JsonObject ?: return Answer(unclear = true)
        val answered = r["answered"].bool == true
        return Answer(
            answered = answered,
            value = r["value"].takeIf { answered },
            needConfirm = r["needConfirm"].string,
            option = r["option"].string,
            unclear = r["unclear"].bool == true,
        )
    }

    fun requestNames(prompt: JsonElement, said: String): Boolean = call("requestNames", prompt, said).bool ?: false
    fun isDestructive(prompt: JsonElement): Boolean = call("isDestructive", prompt).bool ?: false
    fun isBackchannel(text: String, answering: Boolean = false): Boolean = call("isBackchannel", text, answering).bool ?: false
    fun isEcho(heard: String, spoken: String): Boolean = call("isEcho", heard, spoken).bool ?: false
    fun isSignificant(text: String): Boolean = call("isSignificant", text).bool ?: false
    fun speakPrompt(prompt: JsonElement, page: Int = 0): String = call("speakPrompt", prompt, page).string ?: ""
    fun incomplete(text: String): Boolean = call("incomplete", text).bool ?: false
    fun chunks(text: String): List<String> = call("chunks", text).array?.mapNotNull { it.string } ?: emptyList()

    /** `matchSession(list, said)`: list items `{ agent, name, cwd, task, machine }`; returns indices into [list]. */
    fun matchSession(list: List<JsonElement>, said: String): Match {
        // Each item carries its index through the JSON round trip, as the Swift bridge tags the JS objects.
        val tagged = list.mapIndexed { i, item -> JsonObject((item as? JsonObject).orEmpty() + ("__i" to JsonPrimitive(i))) }
        val r = call("matchSession", JsonArray(tagged), said)
        r["match"].takeIf { it is JsonObject }?.let { return Match.One(it["__i"].int ?: 0) }
        r["ambiguous"].array?.let { a -> return Match.Ambiguous(a.map { it["__i"].int ?: 0 }) }
        return Match.None
    }

    /** `new PiVoiceCore.Vad(opts)`. Release it with [Vad.close] when replaced (it lives in the JS heap). */
    fun vad(hangMs: Double? = null, minSpeechMs: Double? = null): Vad {
        val o = buildMap { hangMs?.let { put("hangMs", it) }; minSpeechMs?.let { put("minSpeechMs", it) } }
        return Vad(eval("__pi.vad(${jsonOf(o).encode()})").int ?: error("Vad not created"))
    }

    inner class Vad internal constructor(private val id: Int) : Closeable {
        private val self = "__pi.vads[$id]"

        /** "start" | "end" | null */
        fun feed(rms: Double, now: Double): String? = eval("$self.feed(${num(rms)}, ${num(now)})").string
        fun threshold(): Double = eval("$self.threshold()").double ?: 1.0
        fun setGain(g: Double) { eval("$self.setGain(${num(g)})") }
        fun extend(ms: Double) { eval("$self.extend(${num(ms)})") }
        override fun close() { if (!js.isClosed) eval("delete $self") }
    }

    companion object {
        /** The bundled copy (the `bundleVoiceCore` gradle task copies it from web/ into the assets). */
        fun bundled(context: Context): VoiceCore {
            val script = try {
                context.assets.open("voice-core.js").bufferedReader().use { it.readText() }
            } catch (e: Exception) {
                throw LoadException("not bundled")
            }
            return VoiceCore(script, "bundle")
        }

        /** A prompt as `voice-core.js` expects it (title, message, kind, options). */
        fun prompt(p: JsonElement): JsonElement = p

        private fun quote(s: String) = JsonPrimitive(s).encode()
        private fun num(d: Double) = if (d.isFinite()) d.toString() else "0"

        /** Calls by name with JSON arguments; every result goes back as JSON text (`json`). */
        private const val PRELUDE = """
;globalThis.__pi = {
  vads: {},
  next: 0,
  json(r) { return r === undefined ? null : JSON.stringify(r); },
  call(name, args) { return PiVoiceCore[name](...args); },
  answerFor(prompt, text) {
    const r = PiVoiceCore.answerFor(prompt, text);
    return r && typeof r === "object" ? { ...r, answered: "value" in r } : null;
  },
  vad(o) { const id = ++this.next; this.vads[id] = new PiVoiceCore.Vad(o); return id; },
};
"""
    }
}
