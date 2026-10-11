import SwiftUI

/// The paired app: the web UI, with native loading and offline states instead of WebKit's.
struct ShellView: View {
    let machine: Machine
    @Environment(AppModel.self) private var model
    @State private var phase: ShellPhase = .loading
    @State private var reload = 0
    @State private var showSpinner = false

    var body: some View {
        ZStack {
            Color.piBackground.ignoresSafeArea()
            WebShell(machine: machine, model: model, phase: $phase, reloadToken: reload)
                .ignoresSafeArea()
                .opacity(phase == .ready ? 1 : 0)
                .accessibilityHidden(phase != .ready)
            switch phase {
            case .loading:
                LoadingView(name: machine.name, showSpinner: showSpinner)
                    .task {
                        // A spinner only when loading is noticeably slow; most loads finish first.
                        showSpinner = false
                        try? await Task.sleep(for: .milliseconds(600))
                        showSpinner = true
                    }
            case .offline(let message):
                OfflineView(name: machine.name, message: message) { reload += 1 }
                    .transition(.opacity)
            case .ready:
                EmptyView()
            }
        }
        .animation(.easeOut(duration: 0.2), value: phase)
        .voiceScreen(model.voice)
        .alert(forgetTitle, isPresented: forgetShown, presenting: model.forgetQueue.first) { m in
            Button("Forget", role: .destructive) { model.forget(m) }
            Button("Keep", role: .cancel) { model.keep(m) }
        } message: { _ in
            Text("It still accepts this iPhone. Forgetting removes its key from this iPhone.")
        }
    }

    private var forgetTitle: String {
        let name = model.forgetQueue.first?.name ?? ""
        return name.isEmpty ? "Forget this computer on this iPhone?" : "Forget \(name) on this iPhone?"
    }

    private var forgetShown: Binding<Bool> {
        Binding(get: { !model.forgetQueue.isEmpty }, set: { _ in })
    }
}

struct LoadingView: View {
    let name: String
    let showSpinner: Bool

    var body: some View {
        VStack(spacing: 14) {
            PiMark(size: 64)
            if showSpinner {
                ProgressView()
                    .controlSize(.regular)
                    .transition(.opacity)
                Text(name.isEmpty ? "Connecting…" : "Connecting to \(name)…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }
        }
        .animation(.easeIn(duration: 0.2), value: showSpinner)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name.isEmpty ? "Connecting" : "Connecting to \(name)")
    }
}

struct OfflineView: View {
    let name: String
    let message: String
    let retry: () -> Void
    @State private var retrying = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 52, weight: .regular))
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.hierarchical)
                .padding(.bottom, 20)
                .accessibilityHidden(true)
            Text(name.isEmpty ? "Can't reach your computer" : "Can't reach \(name)")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
                .padding(.bottom, 8)
            Text("\(message.hasPrefix("Can't reach") ? "" : message + " ")Check that pi is running with /remote on, and that this iPhone is on the same Wi-Fi or tailnet.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button {
                retrying = true
                retry()
                Task { try? await Task.sleep(for: .seconds(1)); retrying = false }
            } label: {
                Label("Try again", systemImage: "arrow.clockwise")
                    .font(.headline)
                    .foregroundStyle(Color.accentText)
                    .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .disabled(retrying)
            .sensoryFeedback(.impact(weight: .light), trigger: retrying) { _, new in new }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 24)
        .frame(maxWidth: 520)
    }
}

/// The app's mark: the pi symbol on the accent colour, as in the web UI's header.
struct PiMark: View {
    var size: CGFloat = 72

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(Color.accentColor.gradient)
            .frame(width: size, height: size)
            .overlay {
                Text("π")
                    .font(.system(size: size * 0.56, weight: .semibold, design: .serif))
                    .foregroundStyle(Color.accentText)
                    .offset(y: -size * 0.03)
            }
            .shadow(color: Color.accentColor.opacity(0.25), radius: size * 0.12, y: size * 0.06)
            .accessibilityHidden(true)
    }
}
