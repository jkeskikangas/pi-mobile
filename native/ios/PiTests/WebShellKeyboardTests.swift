import WebKit
import XCTest
@testable import Pi

/// The form accessory bar is hidden for our web view only, and the page hears how much the keyboard covers.
@MainActor
final class WebShellKeyboardTests: XCTestCase {
    func content(_ web: WKWebView) -> UIView? {
        web.scrollView.subviews.first { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }
    }

    func testHidesAccessoryBarOnThisWebViewOnly() throws {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let other = WKWebView(frame: .zero)
        let view = try XCTUnwrap(content(web), "WebKit no longer has a WKContent view in its scroll view")
        let original: AnyClass = try XCTUnwrap(object_getClass(view))

        XCTAssertTrue(FormAccessoryBar.hide(in: web))
        XCTAssertTrue(FormAccessoryBar.hide(in: web), "idempotent")
        XCTAssertNil(view.inputAccessoryView)
        XCTAssertTrue(view.isKind(of: original), "still a WKContentView to WebKit")
        XCTAssertTrue(NSStringFromClass(try XCTUnwrap(object_getClass(view))).hasSuffix(FormAccessoryBar.suffix))
        XCTAssertEqual(object_getClass(try XCTUnwrap(content(other))).map(NSStringFromClass), NSStringFromClass(original),
                       "other web views keep WebKit's class")
    }

    func testKeyboardScript() {
        let web = UIView(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let up = WebShell.Coordinator.keyboardScript(web: web, keyboard: CGRect(x: 0, y: 561, width: 393, height: 291), duration: 0.25, zoom: 1)
        XCTAssertEqual(up, "window.PiNative?.keyboard?.({height:291,duration:250})")
        let zoomed = WebShell.Coordinator.keyboardScript(web: web, keyboard: CGRect(x: 0, y: 561, width: 393, height: 291), duration: 0.25, zoom: 1.2)
        XCTAssertEqual(zoomed, "window.PiNative?.keyboard?.({height:243,duration:250})", "CSS px at the page zoom")
        let down = WebShell.Coordinator.keyboardScript(web: web, keyboard: CGRect(x: 0, y: 852, width: 393, height: 291), duration: 0.25, zoom: 1)
        XCTAssertEqual(down, "window.PiNative?.keyboard?.({height:0,duration:250})")
        XCTAssertTrue(NativeBridge.setupScript(machines: [], prefs: [:]).contains("window.PiNative.keyboardEvents = true"))
    }
}
