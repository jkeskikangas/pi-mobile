package dev.pi_mobile.app.shell

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.JsResult
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.pi_mobile.app.R
import dev.pi_mobile.app.app.AppModel
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.OriginPolicy
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.jsonOf
import dev.pi_mobile.app.core.obj
import dev.pi_mobile.app.core.parseJson
import dev.pi_mobile.app.dictation.Dictation
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** What the shell chrome shows over (or instead of) the web view. */
sealed interface ShellPhase {
    data object Loading : ShellPhase
    data object Ready : ShellPhase

    /** The page can't be shown; [message] says why (never a WebView error page). */
    data class Offline(val message: String) : ShellPhase
}

/**
 * The web UI of the primary computer in an [android.webkit.WebView], already paired through the document-start script
 * (BRIDGE.md → Setup, plans/native-android.md A7). Owns the view, its loading state and the native → JS calls; the
 * page's messages go to [bridge]. Port of native/ios/Pi/Shell/WebShell.swift. Main thread only.
 *
 * Keyboard: the iOS shell hides WebKit's form accessory bar and tells the page the keyboard height. Android has no
 * accessory bar, and the activity pads the web view by the IME inset, so the view itself shrinks with the keyboard,
 * the page (`interactive-widget=resizes-content`) reflows and the composer stays on the keyboard; no events needed.
 *
 * @param host the activity-side services (external links, the photo picker).
 */
class WebShell(
    private val context: Context,
    val machine: Machine,
    private val model: AppModel,
    private val bridge: NativeBridge,
    private val dictation: Dictation,
    private val host: Host,
) {
    /** What the shell needs from the activity. */
    interface Host {
        /** A link out of the app (docs, PRs): the browser, never inside the shell. */
        fun openExternal(uri: Uri)

        /** The photo picker for the composer's attachments; [done] gets the picked images, or null when cancelled. */
        fun chooseImages(multiple: Boolean, done: (Array<Uri>?) -> Unit)
    }

    private val scope = MainScope()
    private val origin = NativeBridge.originRule(machine.origin)
    private val _phase = MutableStateFlow<ShellPhase>(ShellPhase.Loading)
    val phase: StateFlow<ShellPhase> = _phase.asStateFlow()

    private val _view = MutableStateFlow(newWebView())

    /** The web view; replaced by a fresh one if its renderer dies. */
    val view: StateFlow<WebView> = _view.asStateFlow()

    private var script: ScriptHandler? = null

    /** The current load hit an error: its finished page (WebView's error page) must not count as ready. */
    private var failed = false

    /** A notification tap that arrived before the page could take it (BRIDGE.md `focus`). */
    private var pendingFocus: Pair<String, String>? = null

    /** (Re)loads the page with a fresh setup script: the store is the source of truth for machines and prefs. */
    fun load() {
        val web = _view.value
        OriginPolicy.problem(machine.origin)?.let { return offline(it) }
        if (origin == null) return offline("That computer's address isn't valid. Pair it again.")
        if (!supported()) return offline("Update Android System WebView from Google Play, then try again.")
        _phase.value = ShellPhase.Loading
        dictation.cancel() // reload or renderer loss: the old page's take is gone
        script?.remove()
        val zoom = ShellScripts.pageZoom(context.resources.configuration.fontScale)
        val source = ShellScripts.setup(model.machines.value, model.prefs.voicePrefs) + "\n" + ShellScripts.FEEL + "\n" + ShellScripts.zoom(zoom)
        script = WebViewCompat.addDocumentStartJavaScript(web, source, setOf(origin))
        failed = false
        web.loadUrl(machine.origin.trimEnd('/') + "/")
    }

    /** Opens session [agent] on hub machine [machine] (a tapped notification); waits for the page if needed. */
    fun focus(machine: String, agent: String) {
        pendingFocus = machine to agent
        if (_phase.value == ShellPhase.Ready) flushFocus()
    }

    /** The native voice screen closed: the page catches up on prefs voice mode changed, then on the transcript. */
    fun voiceClosed() {
        val prefs = jsonOf(model.prefs.voicePrefs).encode()
        run("try{for(const[k,v]of Object.entries($prefs))localStorage.setItem(k,v)}catch(e){};" + ShellScripts.call("voiceClosed"))
    }

    /** System back: closes the page's viewer or sheet; [unhandled] runs when nothing was open. */
    fun back(unhandled: () -> Unit) {
        if (_phase.value != ShellPhase.Ready) return unhandled()
        _view.value.evaluateJavascript(ShellScripts.BACK) { open -> if (open != "true") unhandled() }
    }

    @SuppressLint("RequiresFeature") // a script exists only if supported() held when it was added
    fun destroy() {
        scope.cancel()
        dictation.cancel() // the page that owned the take is gone
        dictation.js = {}
        dictation.haptic = {}
        script?.remove()
        _view.value.destroy()
    }

    private fun run(js: String) = _view.value.evaluateJavascript(js, null)

    private fun offline(message: String) {
        _phase.value = ShellPhase.Offline(message)
    }

    /** Both androidx.webkit features the shell relies on (WebView 87+); every use below is behind this check. */
    private fun supported() =
        WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    /** The page sets `PiNative.focus` when its main script runs; retry briefly until it exists. */
    private fun flushFocus() {
        val (m, a) = pendingFocus ?: return
        pendingFocus = null
        run("(function f(n){if(window.PiNative&&window.PiNative.focus)" + ShellScripts.call("focus", m, a) + ";else if(n<50)setTimeout(function(){f(n+1)},100)})(0)")
    }

    private fun isPage(url: String?) = url != null && NativeBridge.sameOrigin(url, machine.origin)

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature") // the page is our own app; features: see supported()
    private fun newWebView(): WebView = WebView(context).apply {
        // A WRAP_CONTENT web view (AndroidView's default) sizes the page to its content: 100vh would be 0.
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setBackgroundColor(ContextCompat.getColor(context, R.color.pi_background))
        overScrollMode = View.OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            // `target=_blank` links stay one navigation, so shouldOverrideUrlLoading sends them to the browser.
            setSupportMultipleWindows(false)
            // The page's viewport meta decides the layout width (and the zoom script can narrow it).
            useWideViewPort = true
            loadWithOverviewMode = false
            // Pinch zoom stays (accessibility), without the old on-screen buttons. Text size comes from the zoom script.
            builtInZoomControls = true
            displayZoomControls = false
            textZoom = 100
        }
        webViewClient = Client()
        webChromeClient = Chrome()
        if (supported() && origin != null) {
            WebViewCompat.addWebMessageListener(this, ShellScripts.LISTENER, setOf(origin), ::onMessage)
        }
    }

    @SuppressLint("RequiresFeature") // called only by the listener, which exists only if supported()
    private fun onMessage(view: WebView, message: WebMessageCompat, source: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
        val raw = try { parseJson(message.data ?: return) } catch (_: Exception) { return }
        val id = raw["id"] ?: JsonNull
        // The page that sent the message owns dictation's output from now on.
        dictation.js = { js -> view.evaluateJavascript(js, null) }
        dictation.haptic = { view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }
        scope.launch {
            val msg = raw["msg"] as? JsonObject
            val r = if (msg == null) Reply.Error("unknown message") else bridge.handle(msg, FrameInfo(isMainFrame, source.toString()))
            reply.postMessage(replyJson(id, r))
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            // HTTPS only (OriginPolicy): the page's own origin is already allowed; nothing else loads here.
            if (isPage(url.toString()) && OriginPolicy.problem(url.toString()) == null) return false
            if (url.scheme in setOf("about", "blob", "data")) return false
            if (request.isForMainFrame && request.hasGesture()) host.openExternal(url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (isPage(url) && _phase.value == ShellPhase.Ready) _phase.value = ShellPhase.Loading
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (failed || !isPage(url)) return
            _phase.value = ShellPhase.Ready
            flushFocus()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            failed = true
            offline(errorMessage(error.errorCode))
        }

        /** An HTTP error for the page itself (a proxy, another server on the port) is shown natively, never rendered. */
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (!request.isForMainFrame || response.statusCode < 400) return
            failed = true
            offline(httpMessage(response.statusCode))
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (!isPage(error.url)) return
            failed = true
            offline("This computer's certificate isn't valid for its address. Run /remote there and scan the new code.")
        }

        /** The renderer died (killed for memory, or crashed): a WebView can't be reused after that, so a new one loads. */
        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            if (view !== _view.value) return true
            script = null
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            _view.value = newWebView()
            load()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            // The callback must always be answered (null when cancelled), or the page's file input never opens again.
            host.chooseImages(params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) { callback.onReceiveValue(it) }
            return true
        }

        // Plain dialogs (no "The page at … says" title): the page uses confirm() before revoking or removing.
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult) = dialog(view, message, result, cancel = false)

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult) = dialog(view, message, result, cancel = true)

        private fun dialog(view: WebView, message: String?, result: JsResult, cancel: Boolean): Boolean {
            AlertDialog.Builder(view.context)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .apply { if (cancel) setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() } }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }
    }

    companion object {
        /** `{id, ok}` or `{id, error}` for the shim (ShellScripts.SHIM). */
        fun replyJson(id: JsonElement, r: Reply): String = when (r) {
            is Reply.Value -> obj("id" to id, "ok" to r.value)
            is Reply.Error -> obj("id" to id, "error" to r.message)
        }.encode()

        fun httpMessage(status: Int): String = when (status) {
            404 -> "Something answered at this address, but it isn't pi (HTTP 404)."
            502, 503, 504 -> "Your computer answered, but pi isn't serving right now (HTTP $status)."
            else -> "Your computer answered with an error (HTTP $status)."
        }

        /** The sentence for a failed page load ([WebViewClient] ERROR_* codes), in HubError's words. */
        fun errorMessage(code: Int): String = when (code) {
            WebViewClient.ERROR_TIMEOUT -> "Your computer didn't answer in time."
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> "This computer's secure connection failed. Run /remote there and scan the new code."
            else -> "Can't reach your computer."
        }
    }
}
