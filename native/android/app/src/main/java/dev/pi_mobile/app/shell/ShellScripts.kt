package dev.pi_mobile.app.shell

import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.jsonOf
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale
import kotlin.math.round

/**
 * The JavaScript the shell puts into the page (BRIDGE.md → Setup, plans/native-android.md A7). Pure strings, so
 * JVM tests can read and run them.
 */
object ShellScripts {
    /** The WebMessageListener's JavaScript object (`window.piNativeAndroid`), restricted to the primary origin. */
    const val LISTENER = "piNativeAndroid"

    /**
     * The document-start script: the stored machines, the primary's device record and the voice prefs into
     * `localStorage` (the store is the source of truth; the page's copy is overwritten on every load), then
     * `window.PiNative`'s capabilities, then the `webkit.messageHandlers.piNative` shim.
     *
     * `keyboardEvents` stays unset: on Android the web view itself shrinks with the keyboard (MainActivity pads it by
     * the IME inset), so the page needs no `keyboard(…)` calls.
     */
    fun setup(machines: List<Machine>, prefs: Map<String, String>): String {
        val entries = JsonArray(machines.map { it.webEntry }).encode()
        val device = (machines.firstOrNull { it.primary }?.webDevice ?: JsonNull).encode()
        val p = jsonOf(prefs).encode()
        return """
            (function () {
              try {
                var s = window.localStorage;
                s.setItem("pi-mobile-machines", JSON.stringify($entries));
                var dev = $device;
                if (dev) s.setItem("pi-mobile-device", JSON.stringify(dev)); else s.removeItem("pi-mobile-device");
                var prefs = $p;
                for (var k in prefs) s.setItem(k, prefs[k]);
              } catch (e) {}
              window.PiNative = window.PiNative || {};
              window.PiNative.version = 1;
              window.PiNative.scan = true;
              window.PiNative.consent = true;
              window.PiNative.platform = "android";
            })();
        """.trimIndent() + "\n" + SHIM
    }

    /**
     * `window.webkit.messageHandlers.piNative.postMessage(msg)` returning a Promise, as WKWebView's reply handler
     * does, so `web/` keeps one contract. Each call sends `{id, msg}` as JSON through the message listener; native
     * answers `{id, ok}` or `{id, error}`, which resolves the promise or rejects it with an Error whose message is
     * the text. The listener object is looked up on first use: WebView injects it into matching frames only.
     */
    val SHIM = """
        (function () {
          var pending = {}, next = 0, port = null;
          function connect() {
            if (port) return port;
            var p = window.$LISTENER;
            if (!p) throw new Error("the app is not reachable");
            p.onmessage = function (e) {
              var r;
              try { r = JSON.parse(e.data); } catch (_) { return; }
              var call = pending[r.id];
              if (!call) return;
              delete pending[r.id];
              if ("error" in r) call.reject(new Error(String(r.error)));
              else call.resolve(r.ok === undefined ? null : r.ok);
            };
            return (port = p);
          }
          window.webkit = window.webkit || {};
          window.webkit.messageHandlers = {
            piNative: {
              postMessage: function (msg) {
                return new Promise(function (resolve, reject) {
                  var id = ++next;
                  pending[id] = { resolve: resolve, reject: reject };
                  try { connect().postMessage(JSON.stringify({ id: id, msg: msg })); }
                  catch (e) { delete pending[id]; reject(e); }
                });
              }
            }
          };
        })();
    """.trimIndent()

    /** Native feel once the document exists: no tap flash, no long-press callouts. Pinch zoom stays (accessibility). */
    val FEEL = """
        document.addEventListener("DOMContentLoaded", function () {
          var st = document.createElement("style");
          st.textContent = "a, img { -webkit-touch-callout: none; } * { -webkit-tap-highlight-color: transparent; }";
          document.head.appendChild(st);
        });
    """.trimIndent()

    /**
     * The page's CSS is px, so a larger system font size can't reach it through `textZoom` without breaking the
     * layout. As in the iOS app the layout viewport is narrowed to screen width / zoom and scaled back up: text and
     * controls grow, the page reflows, `dvh` follows. Zoom 1 restores the page's own viewport.
     */
    fun zoom(zoom: Double): String {
        val z = String.format(Locale.US, "%.2f", zoom).trimEnd('0').trimEnd('.')
        return """
            document.addEventListener("DOMContentLoaded", function () {
              var z = $z, m = document.querySelector("meta[name=viewport]");
              if (!m) return;
              if (!m.dataset.orig) m.dataset.orig = m.content;
              m.content = z === 1 ? m.dataset.orig : "width=" + Math.round(screen.width / z) + ", initial-scale=" + z + ", viewport-fit=cover, interactive-widget=resizes-content";
            });
        """.trimIndent()
    }

    /**
     * Page zoom for Android's font scale: 1 up to the default size, then following the scale in 0.05 steps, capped
     * at 1.6 (the iOS app's largest; the CSS width stays above ~245 px).
     */
    fun pageZoom(fontScale: Float): Double {
        if (fontScale <= 1f) return 1.0
        return minOf(1.6, round(fontScale * 20.0) / 20.0)
    }

    /**
     * The system back gesture closes what the page has open (the image viewer, a sheet) through the Escape key the page
     * already handles; evaluates to whether something was open.
     */
    const val BACK = """(function () {
  var open = document.querySelector(".viewer") || (document.getElementById("sheet") && !document.getElementById("sheet").hidden);
  if (open) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return !!open;
})()"""

    /** `window.PiNative?.<fn>?.(args)`: safe while the page is still loading (BRIDGE.md → Native → JS). */
    fun call(fn: String, vararg args: String): String =
        "window.PiNative?.$fn?.(${args.joinToString(",") { JsonPrimitive(it).toString() }})"
}
