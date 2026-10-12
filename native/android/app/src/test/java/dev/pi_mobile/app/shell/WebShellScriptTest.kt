package dev.pi_mobile.app.shell

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.asyncFunction
import com.dokar.quickjs.evaluate
import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The document-start script (BRIDGE.md → Setup) and the `webkit.messageHandlers.piNative` shim, run in QuickJS with a
 * fake `localStorage` and a fake message listener that answers like WebShell does ([WebShell.replyJson]).
 */
class WebShellScriptTest {
    private val js = runBlocking { QuickJs.create(Dispatchers.Default) }
    private val key = Base64Url.encode(ByteArray(32) { 3 })
    private val a = Machine(id = "a", machine = "mx-a", name = "Mac a", origin = "https://a.ts.net", d = "d-a", k = key, primary = true, added = 1.0, lastSeen = 2.0)
    private val b = Machine(id = "b", machine = "mx-b", name = "Mac b", origin = "https://b.ts.net", d = "d-b", k = key, added = 1.0)

    /** What native received, in order. */
    private val received = mutableListOf<JsonObject>()

    @After fun close() = js.close()

    private fun eval(code: String): String? = runBlocking { js.evaluate<String?>(code) }

    /** QuickJS's evaluate runs the jobs but returns the promise itself: park the result in a global and read it. */
    private fun await(promise: String): String? {
        eval("globalThis.__out = null; ($promise).then(function (v) { globalThis.__out = v; }); void 0;")
        return eval("globalThis.__out")
    }

    /** A browser-ish global: `window`, a Map-backed `localStorage`, and the listener object WebView would inject. */
    private fun page(setup: String) {
        js.asyncFunction("nativeReply") { args ->
            val raw = parseJson(args[0] as String)
            val msg = raw["msg"] as JsonObject
            received += msg
            val reply = when (msg["type"].string) {
                "consent.status" -> Reply.Value(obj("granted" to true))
                "dictation.cancel" -> Reply.Value(JsonNull)
                else -> Reply.Error("Microphone access is off. Turn it on in Settings.")
            }
            WebShell.replyJson(raw["id"]!!, reply)
        }
        eval(
            """
            var window = globalThis;
            var store = {};
            window.localStorage = {
              setItem: function (k, v) { store[k] = String(v); },
              getItem: function (k) { return k in store ? store[k] : null; },
              removeItem: function (k) { delete store[k]; }
            };
            window.${ShellScripts.LISTENER} = {
              postMessage: function (s) {
                var port = this;
                if (typeof s !== "string") throw new Error("WebView only carries strings");
                nativeReply(s).then(function (r) { port.onmessage({ data: r }); });
              }
            };
            $setup
            void 0;
            """.trimIndent(),
        )
    }

    @Test fun setupWritesTheStoreIntoLocalStorageAndDeclaresPiNative() {
        page(ShellScripts.setup(listOf(a, b), mapOf("pi-mobile-voice-persona" to "cedar")))
        val machines = parseJson(eval("localStorage.getItem('pi-mobile-machines')")!!) as JsonArray
        assertEquals(listOf(a.webEntry, b.webEntry), machines)
        assertEquals("the primary is reached at the page origin", null, machines[0]["origin"])
        assertEquals("https://b.ts.net", machines[1]["origin"].string)
        assertEquals(obj("d" to "d-a", "k" to key, "role" to "control", "host" to "Mac a"), parseJson(eval("localStorage.getItem('pi-mobile-device')")!!))
        assertEquals("cedar", eval("localStorage.getItem('pi-mobile-voice-persona')"))
        assertEquals(
            """{"version":1,"scan":true,"consent":true,"platform":"android"}""",
            eval("JSON.stringify(window.PiNative)"),
        )
        assertEquals("no keyboard(…) calls on Android", "undefined", eval("typeof window.PiNative.keyboardEvents"))
    }

    @Test fun anEmptyStoreClearsThePagesDevice() {
        page("localStorage.setItem('pi-mobile-device', 'stale');" + ShellScripts.setup(emptyList(), emptyMap()))
        assertEquals("[]", eval("localStorage.getItem('pi-mobile-machines')"))
        assertEquals(null, eval("localStorage.getItem('pi-mobile-device')"))
    }

    @Test fun piNativeIsExtendedNeverReplaced() {
        page("window.PiNative = { level: function () {} };" + ShellScripts.setup(listOf(a), emptyMap()))
        assertEquals("function android", eval("typeof window.PiNative.level + ' ' + window.PiNative.platform"))
    }

    @Test fun postMessageResolvesWithTheReplyAndRejectsWithTheSentence() {
        page(ShellScripts.setup(listOf(a), emptyMap()))
        val out = await(
            """
            (async function () {
              var h = window.webkit.messageHandlers.piNative;
              var granted = await h.postMessage({ type: "consent.status" });
              var none = await h.postMessage({ type: "dictation.cancel" });
              var err;
              try { await h.postMessage({ type: "dictation.start" }); } catch (e) { err = (e instanceof Error) + ": " + e.message; }
              // Concurrent calls each get their own reply.
              var both = await Promise.all([h.postMessage({ type: "consent.status" }), h.postMessage({ type: "dictation.cancel" })]);
              return JSON.stringify({ granted: granted, none: none, err: err, both: both });
            })()
            """.trimIndent(),
        )
        assertEquals(
            """{"granted":{"granted":true},"none":null,"err":"true: Microphone access is off. Turn it on in Settings.","both":[{"granted":true},null]}""",
            out,
        )
        assertEquals(listOf("consent.status", "dictation.cancel", "dictation.start", "consent.status", "dictation.cancel"), received.map { it["type"].string })
    }

    @Test fun withoutTheListenerPostMessageRejects() {
        eval("var window = globalThis; window.localStorage = { setItem: function () {}, removeItem: function () {} };" + ShellScripts.setup(emptyList(), emptyMap()))
        val out = await("(async function () { try { await window.webkit.messageHandlers.piNative.postMessage({ type: 'x' }); return 'resolved'; } catch (e) { return e.message; } })()")
        assertEquals("the app is not reachable", out)
    }

    @Test fun nativeToJsCallsAreGuardedAndEscaped() {
        assertEquals("""window.PiNative?.focus?.("mx-a","ag\"1")""", ShellScripts.call("focus", "mx-a", "ag\"1"))
        page(ShellScripts.setup(emptyList(), emptyMap()))
        // The page hasn't added voiceClosed yet: nothing throws.
        assertEquals("ok", eval(ShellScripts.call("voiceClosed") + "; 'ok'"))
    }

    @Test fun fontScaleMapsToPageZoom() {
        assertEquals(1.0, ShellScripts.pageZoom(0.85f), 0.0)
        assertEquals(1.0, ShellScripts.pageZoom(1.0f), 0.0)
        assertEquals(1.15, ShellScripts.pageZoom(1.15f), 1e-9)
        assertEquals(1.3, ShellScripts.pageZoom(1.3f), 1e-9)
        assertEquals("capped", 1.6, ShellScripts.pageZoom(2.0f), 0.0)
        assertTrue(ShellScripts.zoom(1.6).contains("var z = 1.6,"))
        assertTrue(ShellScripts.zoom(1.0).contains("var z = 1,"))
    }

    @Test fun feelScriptKeepsPinchZoom() {
        assertFalse(ShellScripts.FEEL.contains("user-scalable"))
        assertFalse(ShellScripts.FEEL.contains("maximum-scale"))
    }

    @Test fun backClosesWhatThePageHasOpen() {
        val escapes = """
            var window = globalThis, sent = [];
            function KeyboardEvent(type, init) { this.type = type; this.key = init.key; }
            var sheet = { hidden: true }, viewer = null;
            var document = {
              querySelector: function () { return viewer; },
              getElementById: function () { return sheet; },
              dispatchEvent: function (e) { sent.push(e.key); }
            };
        """.trimIndent()
        eval(escapes + "void 0;")
        assertEquals("false", eval("String(${ShellScripts.BACK})"))
        assertEquals("true", eval("sheet.hidden = false; String(${ShellScripts.BACK})"))
        assertEquals("true", eval("sheet.hidden = true; viewer = {}; String(${ShellScripts.BACK})"))
        assertEquals("Escape,Escape", eval("sent.join()"))
    }
}
