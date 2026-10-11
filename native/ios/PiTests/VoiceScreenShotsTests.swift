import SwiftUI
import UIKit
import XCTest
@testable import Pi

/// Snapshots of every voice screen state in light and dark, for review (plans/native-apps.md §8).
/// Runs only when asked: `TEST_RUNNER_VOICE_SHOTS=<dir> xcodebuild test -only-testing:PiTests/VoiceScreenShotsTests`.
@MainActor
final class VoiceScreenShotsTests: XCTestCase {
    func testSnapshotEveryState() async throws {
        guard let dir = ProcessInfo.processInfo.environment["VOICE_SHOTS"], !dir.isEmpty else { throw XCTSkip("Set VOICE_SHOTS to write snapshots") }
        let device = (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "device")
            .lowercased().replacingOccurrences(of: "iphone ", with: "").replacingOccurrences(of: #"\s*\(.*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: " ", with: "-")
        let only = ProcessInfo.processInfo.environment["VOICE_SHOTS_ONLY"].map { Set($0.split(separator: ",").map(String.init)) }
        let large = ProcessInfo.processInfo.environment["VOICE_SHOTS_AX"] != nil
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        for name in VoiceFixtures.names where only?.contains(name) ?? true {
            for style in [UIUserInterfaceStyle.light, .dark] {
                let window = UIWindow(windowScene: scene)
                window.windowLevel = .alert + 1
                window.overrideUserInterfaceStyle = style
                let root = VoiceScreen(engine: VoiceFixtures.engine(name))
                    .environment(\.dynamicTypeSize, large ? .accessibility3 : .large)
                window.rootViewController = UIHostingController(rootView: root)
                window.makeKeyAndVisible()
                try await Task.sleep(for: .milliseconds(700))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let file = "\(dir)/\(device)-\(name)\(large ? "-ax" : "")-\(style == .dark ? "dark" : "light").png"
                try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: file))
                window.isHidden = true
            }
        }
    }
}
