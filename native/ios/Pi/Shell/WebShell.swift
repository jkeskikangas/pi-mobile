import SwiftUI
import WebKit

/// The web UI in a `WKWebView`, already paired through the document-start script (BRIDGE.md).
struct WebShell: UIViewRepresentable {
    let machine: Machine
    let model: AppModel
    @Binding var phase: ShellPhase
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.dataDetectorTypes = []
        config.websiteDataStore = .default()
        let ucc = config.userContentController
        ucc.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "piNative")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        web.isOpaque = false
        web.backgroundColor = .piBackground
        web.underPageBackgroundColor = .piBackground
        web.scrollView.backgroundColor = .piBackground
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.contentInsetAdjustmentBehavior = .never // the page uses viewport-fit=cover
        web.scrollView.keyboardDismissMode = .interactive
        // Dynamic Type for the page (its CSS is px). `pageZoom` scales but keeps a device-width layout viewport on
        // iOS (the page then overflows sideways and 100dvh runs off screen), so the viewport is narrowed instead.
        context.coordinator.textSize = NotificationCenter.default.addObserver(forName: UIContentSizeCategory.didChangeNotification, object: nil, queue: .main) { [weak web] _ in
            MainActor.assumeIsolated { _ = web?.evaluateJavaScript(WebShell.zoomScript(WebShell.currentZoom)) }
        }
        #if DEBUG
        web.isInspectable = true
        #endif
        let prefs = model.prefs
        context.coordinator.voiceClosed = NotificationCenter.default.addObserver(forName: .piVoiceClosed, object: nil, queue: .main) { [weak web] _ in
            MainActor.assumeIsolated {
                // Settings changed on the native voice screen reach the live page before it hears voice ended.
                let json = (try? JSONSerialization.data(withJSONObject: prefs.all)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                _ = web?.evaluateJavaScript("try{for(const[k,v]of Object.entries(\(json)))localStorage.setItem(k,v)}catch{};window.PiNative?.voiceClosed?.()")
            }
        }
        context.coordinator.load(web)
        return web
    }

    static var currentZoom: CGFloat { pageZoom(for: UIApplication.shared.preferredContentSizeCategory) }

    /// Narrows the layout viewport to screen width / zoom and scales it back up: text and controls grow, the page
    /// reflows, `dvh` follows. Pinch zoom stays. Zoom 1 restores the page's own viewport.
    static func zoomScript(_ zoom: CGFloat) -> String {
        """
        (function (z) {
          var m = document.querySelector('meta[name=viewport]');
          if (!m) return;
          if (!m.dataset.orig) m.dataset.orig = m.content;
          m.content = z === 1 ? m.dataset.orig : 'width=' + Math.round(screen.width / z) + ', initial-scale=' + z + ', viewport-fit=cover, interactive-widget=resizes-content';
        })(\(zoom));
        """
    }

    /// Page zoom per text size: the default size is 1, accessibility sizes cap at 1.6 (CSS width stays >= ~245 px).
    static func pageZoom(for size: UIContentSizeCategory) -> CGFloat {
        switch size {
        case .extraSmall, .small, .medium, .large: 1.0
        case .extraLarge: 1.1
        case .extraExtraLarge: 1.2
        case .extraExtraExtraLarge: 1.3
        case .accessibilityMedium: 1.45
        case .accessibilityLarge, .accessibilityExtraLarge, .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge: 1.6
        default: 1.0
        }
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if c.reloadToken != reloadToken {
            c.reloadToken = reloadToken
            c.load(web)
        }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeAllScriptMessageHandlers()
        Dictation.shared.cancel() // the page that owned the take is gone
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        var parent: WebShell
        var reloadToken: Int
        /// Observer for `.piVoiceClosed` (BRIDGE.md `voiceClosed()`).
        var voiceClosed: NSObjectProtocol?
        /// Observer for text size changes (page zoom).
        var textSize: NSObjectProtocol?

        init(_ parent: WebShell) {
            self.parent = parent
            reloadToken = parent.reloadToken
        }

        var origin: URL? { parent.machine.url }

        func load(_ web: WKWebView) {
            guard let url = origin.map({ $0.appending(path: "") }) else { return parent.phase = .offline("That computer's address isn't valid. Pair it again.") }
            parent.phase = .loading
            PushCenter.shared.pageUnloaded()
            Dictation.shared.cancel() // reload or content-process loss: the old page's take is gone
            // Fresh on every load: the Keychain is the source of truth for machines and prefs.
            let ucc = web.configuration.userContentController
            ucc.removeAllUserScripts()
            ucc.addUserScript(WKUserScript(source: NativeBridge.setupScript(machines: parent.model.machines, prefs: parent.model.prefs.all), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            ucc.addUserScript(WKUserScript(source: NativeBridge.feelScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            ucc.addUserScript(WKUserScript(source: WebShell.zoomScript(WebShell.currentZoom), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            web.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15))
        }

        // MARK: Navigation

        private func sameOrigin(_ url: URL?) -> Bool {
            guard let url, let o = origin else { return false }
            return url.scheme == o.scheme && url.host() == o.host() && (url.port ?? 0) == (o.port ?? 0)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if sameOrigin(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
            // Links out of the app (docs, PRs) open in Safari, never inside the shell.
            if action.navigationType == .linkActivated || action.targetFrame == nil { await UIApplication.shared.open(url) }
            return .cancel
        }

        /// An HTTP error for the page itself (a proxy, another server on the port) is shown natively, never rendered.
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            guard response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 else { return .allow }
            parent.phase = .offline(Self.message(status: http.statusCode))
            return .cancel
        }

        static func message(status: Int) -> String {
            switch status {
            case 404: "Something answered at this address, but it isn't pi (HTTP 404)."
            case 502, 503, 504: "Your computer answered, but pi isn't serving right now (HTTP \(status))."
            default: "Your computer answered with an error (HTTP \(status))."
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.phase = .ready
            PushCenter.shared.pageLoaded { [weak webView] s in webView?.evaluateJavaScript(s) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            load(webView)
        }

        private func fail(_ error: Error) {
            let e = error as NSError
            if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return }
            // Frame load interrupted by our own policy (an external link, or an HTTP error already shown).
            if e.domain == "WebKitErrorDomain", e.code == 102 { return }
            parent.phase = .offline(HubError.from(error).errorDescription ?? "Can't reach your computer.")
        }

        // MARK: piNative

        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
            let o = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, let p = origin, o.protocol == p.scheme, o.host == p.host(), o.port == (p.port ?? 0) else {
                return (nil, "not allowed")
            }
            let bridge = NativeBridge(model: parent.model, primaryOrigin: parent.machine.origin)
            if let web = message.webView { Dictation.shared.js = { [weak web] s in web?.evaluateJavaScript(s) } }
            switch await bridge.handle(JSON(any: message.body)) {
            case .value(let v): return (v.foundation, nil)
            case .error(let e): return (nil, e)
            }
        }
    }
}

enum ShellPhase: Equatable {
    case loading
    case ready
    case offline(String)
}
