import SwiftUI
import UIKit
import XCTest
@testable import Pi

/// Snapshots of the consent sheet in light and dark (and at an accessibility text size), for review.
/// Runs only when asked: `TEST_RUNNER_CONSENT_SHOTS=<dir> xcodebuild test -only-testing:PiTests/ConsentShotsTests`.
@MainActor
final class ConsentShotsTests: XCTestCase {
    func testSnapshotConsentSheet() async throws {
        guard let dir = ProcessInfo.processInfo.environment["CONSENT_SHOTS"], !dir.isEmpty else { throw XCTSkip("Set CONSENT_SHOTS to write snapshots") }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for (suffix, size) in [("", DynamicTypeSize.large), ("-ax", .accessibility2)] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                let window = UIWindow(windowScene: scene)
                window.windowLevel = .alert + 1
                window.overrideUserInterfaceStyle = style
                window.rootViewController = UIHostingController(rootView: ConsentSheet(purpose: .voice, onChoice: { _ in }).environment(\.dynamicTypeSize, size))
                window.makeKeyAndVisible()
                try await Task.sleep(for: .milliseconds(600))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: "\(dir)/consent\(suffix)-\(style == .dark ? "dark" : "light").png"))
                window.isHidden = true
            }
        }
    }
}
