import SwiftUI
import VisionKit

/// Full-screen QR scanner (VisionKit DataScanner, QR only).
struct ScannerScreen: View {
    let onCode: (String) -> Void
    let onPaste: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var hint = "Point at the code from /remote"
    @State private var unavailable = false
    @State private var done = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if DataScannerViewController.isSupported && !unavailable {
                ScannerView(onUnavailable: { message in
                    unavailable = true
                    hint = message
                }) { payload in
                    guard !done else { return }
                    if PairingLink(payload) != nil {
                        done = true
                        onCode(payload)
                    } else {
                        hint = "That code isn't from pi. Scan the one /remote shows."
                    }
                }
                .ignoresSafeArea()
                .accessibilityLabel("Camera")
            }
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(.white.opacity(0.9), lineWidth: 3)
                .frame(width: 250, height: 250)
                .accessibilityHidden(true)
            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .tint(.white)
                    .accessibilityLabel("Close")
                }
                .padding(.horizontal, 16)
                Spacer()
                Text(hint)
                    .font(.callout.weight(.medium))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .environment(\.colorScheme, .dark)
                    .padding(.bottom, 12)
                    .accessibilityAddTraits(.updatesFrequently)
                Button("Paste link instead", action: onPaste)
                    .font(unavailable ? .headline : .body.weight(.medium))
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(unavailable ? .white : .clear)
                    .foregroundStyle(unavailable ? .black : .white)
                    .tint(.white)
                    .frame(minHeight: 44)
                    .padding(.bottom, 12)
            }
        }
        .statusBarHidden()
    }
}

struct ScannerView: UIViewControllerRepresentable {
    let onUnavailable: (String) -> Void
    let onPayload: (String) -> Void

    static let unavailableMessage = "The camera isn't available right now. Paste the link instead."

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload, onUnavailable: onUnavailable) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: false,
            isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        if !DataScannerViewController.isAvailable {
            Task { @MainActor in onUnavailable(Self.unavailableMessage) }
        } else {
            do { try vc.startScanning() } catch {
                Task { @MainActor in onUnavailable(Self.unavailableMessage) }
            }
        }
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: DataScannerViewController, coordinator: Coordinator) {
        vc.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: (String) -> Void
        let onUnavailable: (String) -> Void
        init(onPayload: @escaping (String) -> Void, onUnavailable: @escaping (String) -> Void) {
            self.onPayload = onPayload
            self.onUnavailable = onUnavailable
        }

        /// Camera taken by another app, restricted, or interrupted mid-scan.
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            onUnavailable(ScannerView.unavailableMessage)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let code) = item, let s = code.payloadStringValue { onPayload(s); return }
            }
        }
    }
}
