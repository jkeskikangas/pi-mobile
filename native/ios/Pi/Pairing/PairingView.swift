import AVFoundation
import SwiftUI
import VisionKit

/// First launch: pair with a computer by scanning the `/remote` code, or pasting its link.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var pairing = false
    @State private var error: String?
    @State private var scanning = false
    @State private var pasting = false
    @State private var camera = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var paired = 0
    @State private var failed = 0

    private var scannerSupported: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-PiAssumeScanner") { return true }
        #endif
        return DataScannerViewController.isSupported
    }

    private var cameraDenied: Bool { camera == .denied || camera == .restricted }

    var body: some View {
        GeometryReader { proxy in
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 32)
                PiMark(size: 76)
                    .padding(.bottom, 28)
                Text("Pair with your computer")
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 10)
                Text("Continue every pi session from this iPhone.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 36)
                VStack(alignment: .leading, spacing: 18) {
                    StepRow(number: 1, text: "On your computer, run **/remote** in pi.")
                    StepRow(number: 2, text: scannerSupported ? "Scan the code it shows." : "Copy the link it shows and paste it here.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 32)
                Spacer(minLength: 0) // sit a little above centre
            }
            .padding(.horizontal, 28)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity, minHeight: proxy.size.height)
        }
        .scrollBounceBehavior(.basedOnSize)
        }
        .safeAreaInset(edge: .bottom) { actions }
        .background(Color.piBackground.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            ScannerScreen(onCode: { code in
                scanning = false
                Task { await pair(code) }
            }, onPaste: {
                scanning = false
                pasting = true
            })
        }
        .sheet(isPresented: $pasting) {
            PasteLinkSheet { text in
                pasting = false
                Task { await pair(text) }
            }
            .presentationDetents([.medium])
        }
        .sensoryFeedback(.success, trigger: paired)
        .sensoryFeedback(.error, trigger: failed)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { camera = AVCaptureDevice.authorizationStatus(for: .video) }
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            if let error {
                Notice(symbol: "exclamationmark.triangle.fill", tint: .red, text: error)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if cameraDenied && scannerSupported {
                Notice(symbol: "camera.fill", tint: .orange, text: "Camera access is off. Turn it on in Settings to scan, or paste the link.") {
                    Button("Open Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                        .font(.subheadline.weight(.semibold))
                }
            }
            if scannerSupported && !cameraDenied {
                primaryButton("Scan code", symbol: "qrcode.viewfinder") { Task { await startScan() } }
                secondaryButton("Paste link instead") { pasting = true }
            } else {
                primaryButton("Paste link", symbol: "doc.on.clipboard") { pasting = true }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity)
        .background(Color.piBackground)
        .animation(.snappy, value: error)
    }

    private func primaryButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if pairing {
                    ProgressView().tint(Color.accentText)
                    Text("Pairing…")
                } else {
                    Image(systemName: symbol)
                    Text(title)
                }
            }
            .font(.headline)
            .foregroundStyle(Color.accentText)
            .frame(maxWidth: .infinity, minHeight: 34)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .disabled(pairing)
        .accessibilityLabel(pairing ? "Pairing" : title)
    }

    private func secondaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.body.weight(.medium))
            .frame(minHeight: 44)
            .disabled(pairing)
    }

    private func startScan() async {
        error = nil
        if camera == .notDetermined {
            let ok = await AVCaptureDevice.requestAccess(for: .video)
            camera = AVCaptureDevice.authorizationStatus(for: .video)
            if !ok { return }
        }
        guard !cameraDenied else { return }
        // Supported hardware can still be unavailable (camera in use, restricted by Screen Time).
        guard DataScannerViewController.isAvailable else {
            failed += 1
            error = ScannerView.unavailableMessage
            return
        }
        scanning = true
    }

    private func pair(_ text: String) async {
        error = nil
        guard let link = PairingLink(text) else {
            failed += 1
            error = "That isn't a pairing link. Run /remote in pi and scan or copy the code it shows."
            return
        }
        pairing = true
        defer { pairing = false }
        do {
            try await model.pair(link)
            paired += 1
        } catch {
            failed += 1
            self.error = Self.message(for: error)
        }
    }

    static func message(for error: Error) -> String {
        switch HubError.from(error) {
        case .expired: "That code was already used or has expired. Run /remote again for a new one."
        case .unauthorized: "That code isn't valid. Run /remote again for a new one."
        case .remote(let m): m
        case .network: "Can't reach your computer. Check that this iPhone is on the same Wi-Fi or tailnet, and that pi is running."
        }
    }
}

private struct StepRow: View {
    let number: Int
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("\(number)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 28, height: 28)
                .background(Color.accentColor.opacity(0.12), in: Circle())
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
            Text(text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Step \(number). ") + Text(text))
    }
}

struct Notice<Accessory: View>: View {
    let symbol: String
    let tint: Color
    let text: String
    @ViewBuilder var accessory: Accessory

    init(symbol: String, tint: Color, text: String, @ViewBuilder accessory: () -> Accessory = { EmptyView() }) {
        self.symbol = symbol
        self.tint = tint
        self.text = text
        self.accessory = accessory()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(text)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                accessory
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// Paste the `/remote` link. Uses the system Paste button, so no paste-permission prompt.
struct PasteLinkSheet: View {
    let onPair: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Copy the link that /remote shows on your computer, then paste it here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                TextField("http://…/#p=…", text: $text, axis: .vertical)
                    .lineLimit(2...4)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .focused($focused)
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityLabel("Pairing link")
                    .onSubmit { if !text.isEmpty { onPair(text) } }
                HStack {
                    PasteButton(payloadType: String.self) { items in
                        if let s = items.first { Task { @MainActor in onPair(s) } }
                    }
                    .buttonBorderShape(.capsule)
                    Spacer()
                    Button("Pair") { onPair(text) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Spacer()
            }
            .padding(20)
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Paste link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}
