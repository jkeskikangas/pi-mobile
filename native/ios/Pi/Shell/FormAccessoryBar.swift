import ObjectiveC
import UIKit
import WebKit

/// Hides WebKit's form accessory bar (the "^ v ✓" bar above the keyboard) for one web view, so the composer sits
/// directly on the keyboard like a native text field. The same technique as Capacitor's Keyboard plugin and
/// Cordova's `hideKeyboardFormAccessoryBar`: the web view's content view (private `WKContentView`, the first
/// responder for page inputs) gets a runtime subclass whose `inputAccessoryView` is nil. Only this instance's class
/// changes (`object_setClass`); no method is swizzled globally. Text input, IME, autocorrect, dictation and the
/// interactive dismiss are the keyboard's own and don't depend on the accessory view.
///
/// The bar's Done was a way to put the keyboard away; without it, a swipe down the page does (the web view's
/// `keyboardDismissMode` is `.interactive`), as does sending.
@MainActor
enum FormAccessoryBar {
    static let suffix = "_PiNoAccessoryBar"

    /// Idempotent. Returns whether the content view is (now) the subclass; false if WebKit's layout changed (then the
    /// bar simply stays, nothing breaks).
    @discardableResult
    static func hide(in web: WKWebView) -> Bool {
        guard let content = web.scrollView.subviews.first(where: { NSStringFromClass(object_getClass($0)!).hasPrefix("WKContent") }),
              let base = object_getClass(content) else { return false }
        let name = NSStringFromClass(base)
        if name.hasSuffix(suffix) { return true }
        // A KVO-observed instance already has a runtime class; swapping it would break the observation.
        if name.hasPrefix("NSKVONotifying_") { return false }
        guard let sub = subclass(of: base) else { return false }
        object_setClass(content, sub)
        return true
    }

    private static func subclass(of base: AnyClass) -> AnyClass? {
        let name = NSStringFromClass(base) + suffix
        if let existing = NSClassFromString(name) { return existing }
        let getter = #selector(getter: UIResponder.inputAccessoryView)
        guard let method = class_getInstanceMethod(base, getter), let sub = objc_allocateClassPair(base, name, 0) else { return nil }
        let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
        class_addMethod(sub, getter, imp_implementationWithBlock(none), method_getTypeEncoding(method))
        objc_registerClassPair(sub)
        return sub
    }
}
