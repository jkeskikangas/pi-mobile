import AVFoundation
import SwiftUI
import VisionKit

/// Outcome of a `scan` bridge message (BRIDGE.md).
enum ScanResult: Equatable {
    case link(String)
    case cancelled
    case busy
    /// Shown to the user as is.
    case unavailable(String)
}

/// Presents the pairing-code scanner over the web shell for the page's "Add a computer" sheet.
/// One scan at a time; ShellView shows the sheet while `isOpen`.
@MainActor @Observable
final class ScanCenter {
    static let shared = ScanCenter()
    static let unsupported = "The camera isn't available on this iPhone. Paste the link instead."
    static let denied = "Camera access is off. Turn it on in Settings, or paste the link instead."

    private(set) var isOpen = false
    @ObservationIgnored private var pending: CheckedContinuation<ScanResult, Never>?

    func scan() async -> ScanResult {
        guard pending == nil else { return .busy }
        guard DataScannerViewController.isSupported else { return .unavailable(Self.unsupported) }
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted: return .unavailable(Self.denied)
        default: break
        }
        // Supported hardware can still be unavailable (camera in use, restricted by Screen Time).
        guard DataScannerViewController.isAvailable else { return .unavailable(ScannerView.unavailableMessage) }
        guard pending == nil else { return .busy } // another scan started while permission was asked
        return await withCheckedContinuation { c in
            pending = c
            isOpen = true
        }
    }

    /// Ends the open scan (if any) with `result` and closes the sheet.
    func finish(_ result: ScanResult) {
        let c = pending
        pending = nil
        isOpen = false
        c?.resume(returning: result)
    }
}

struct ScanSheetPresenter: ViewModifier {
    let center: ScanCenter

    func body(content: Content) -> some View {
        // Closing (✕, swipe down) sets the binding false: the page hears "cancelled".
        content.sheet(isPresented: Binding(get: { center.isOpen }, set: { if !$0 { center.finish(.cancelled) } })) {
            ScannerScreen(onCode: { center.finish(.link($0)) }, onPaste: { center.finish(.cancelled) })
        }
    }
}

extension View {
    /// Present the scanner while a page-requested scan is open.
    func scanSheet(_ center: ScanCenter = .shared) -> some View { modifier(ScanSheetPresenter(center: center)) }
}
