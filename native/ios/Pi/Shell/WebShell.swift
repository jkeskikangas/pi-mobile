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
        #if DEBUG
        web.isInspectable = true
        #endif
        context.coordinator.load(web)
        return web
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
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        var parent: WebShell
        var reloadToken: Int

        init(_ parent: WebShell) {
            self.parent = parent
            reloadToken = parent.reloadToken
        }

        var origin: URL? { parent.machine.url }

        func load(_ web: WKWebView) {
            guard let url = origin.map({ $0.appending(path: "") }) else { return parent.phase = .offline("That computer's address isn't valid. Pair it again.") }
            parent.phase = .loading
            // Fresh on every load: the Keychain is the source of truth for machines and prefs.
            let ucc = web.configuration.userContentController
            ucc.removeAllUserScripts()
            ucc.addUserScript(WKUserScript(source: NativeBridge.setupScript(machines: parent.model.machines, prefs: parent.model.prefs.all), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            ucc.addUserScript(WKUserScript(source: NativeBridge.feelScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
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

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.phase = .ready
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
            if e.domain == "WebKitErrorDomain", e.code == 102 { return } // frame load interrupted by our own policy
            parent.phase = .offline(HubError.from(error).errorDescription ?? "Can't reach your computer.")
        }

        // MARK: piNative

        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
            let o = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame, let p = origin, o.protocol == p.scheme, o.host == p.host(), o.port == (p.port ?? 0) else {
                return (nil, "not allowed")
            }
            let bridge = NativeBridge(model: parent.model, primaryOrigin: parent.machine.origin)
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
