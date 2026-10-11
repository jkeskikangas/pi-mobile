import SwiftUI
import VisionKit

/// Full-screen QR scanner (VisionKit DataScanner, QR only).
struct ScannerScreen: View {
    let onCode: (String) -> Void
    let onPaste: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var hint = "Point at the code from /remote"
    @State private var done = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if DataScannerViewController.isSupported {
                ScannerView { payload in
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
                    .font(.body.weight(.medium))
                    .tint(.white)
                    .frame(minHeight: 44)
                    .padding(.bottom, 12)
            }
        }
        .statusBarHidden()
    }
}

struct ScannerView: UIViewControllerRepresentable {
    let onPayload: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPayload: onPayload) }

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
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: DataScannerViewController, coordinator: Coordinator) {
        vc.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onPayload: (String) -> Void
        init(onPayload: @escaping (String) -> Void) { self.onPayload = onPayload }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let code) = item, let s = code.payloadStringValue { onPayload(s); return }
            }
        }
    }
}
