import SwiftUI

/// The paired app: the web UI, with native loading and offline states instead of WebKit's.
struct ShellView: View {
    let machine: Machine
    @Environment(AppModel.self) private var model
    @State private var phase: ShellPhase = .loading
    @State private var reload = 0
    @State private var showSpinner = false
    /// Automatic retries since the last successful load (backoff), and the seconds until the next one.
    @State private var attempt = 0
    @State private var retryIn: Int?
    /// Other paired computers that answered while this one is unreachable.
    @State private var reachable: [Machine] = []
    @State private var switchError: String?
    @State private var network = NetworkWatch()
    @Environment(\.scenePhase) private var scenePhase

    private var isOffline: Bool { if case .offline = phase { true } else { false } }
    private func retryNow() { retryIn = nil; reload += 1 }
    static let backoff = [2, 4, 8, 15, 30]

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
                OfflineView(name: machine.name, message: message, retryIn: retryIn, others: reachable, error: switchError,
                            retry: retryNow, use: use, talk: talk)
                    .transition(.opacity)
                    .task(id: attempt) { await autoRetry() }
                    .task { await probeOthers() }
            case .ready:
                EmptyView()
            }
        }
        .animation(.easeOut(duration: 0.2), value: phase)
        .onChange(of: phase) { _, p in
            if p == .ready { attempt = 0; retryIn = nil; reachable = [] }
        }
        // Back in the app, or the network came back: try at once instead of waiting out the backoff.
        .onChange(of: scenePhase) { _, p in if p == .active && isOffline { retryNow() } }
        .onChange(of: network.changes) { if isOffline && network.online { retryNow() } }
        .voiceScreen(model.voice)
        .scanSheet()
        .alert(forgetTitle, isPresented: forgetShown, presenting: model.forgetQueue.first) { m in
            Button("Forget", role: .destructive) { model.forget(m) }
            Button("Keep", role: .cancel) { model.keep(m) }
        } message: { _ in
            Text("It still accepts this iPhone. Forgetting removes its key from this iPhone.")
        }
    }

    /// Counts down to the next automatic retry (2, 4, 8, 15, then every 30 s) while offline and in front.
    private func autoRetry() async {
        let delay = Self.backoff[min(attempt, Self.backoff.count - 1)]
        for left in stride(from: delay, to: 0, by: -1) {
            retryIn = left
            try? await Task.sleep(for: .seconds(1))
            if Task.isCancelled { return }
        }
        guard scenePhase == .active, isOffline else { return }
        attempt += 1
        retryNow()
    }

    /// The web UI can't load from this computer, but another one may serve it (each computer serves the app).
    private func probeOthers() async {
        let others = model.machines.filter { $0.id != machine.id }
        guard !others.isEmpty else { return }
        var ok: [Machine] = []
        await withTaskGroup(of: Machine?.self) { g in
            for m in others {
                guard let c = model.client(for: m) else { continue }
                g.addTask {
                    // A short budget: this only decides which buttons to offer.
                    let probe = Task { try await c.hub() }
                    let timer = Task { try await Task.sleep(for: .seconds(5)); probe.cancel() }
                    defer { timer.cancel() }
                    return (try? await probe.value) != nil ? m : nil
                }
            }
            for await m in g { if let m { ok.append(m) } }
        }
        reachable = others.filter { m in ok.contains { $0.id == m.id } }
    }

    private func use(_ m: Machine) {
        do { try model.makePrimary(m) } catch { switchError = error.localizedDescription }
    }

    /// Voice mode needs no web view: start it on the session that needs you (or the last one), like Siri does.
    private func talk() {
        Task {
            let c = VoiceActivityController.shared
            guard let t = await c.pickSession() else { switchError = "No session is reachable right now."; return }
            do { try await c.startEngine(for: t) } catch { switchError = error.localizedDescription }
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
    /// Seconds until the next automatic try; nil while a try is under way.
    let retryIn: Int?
    /// Other computers that answered: the app can open from one of them.
    let others: [Machine]
    let error: String?
    let retry: () -> Void
    let use: (Machine) -> Void
    let talk: () -> Void
    @State private var taps = 0

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 32)
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
                        .accessibilityAddTraits(.isHeader)
                    Text("\(message.hasPrefix("Can't reach") ? "" : message + " ")Check that pi is running with /remote on, and that this iPhone is on the same Wi-Fi or tailnet.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.bottom, 14)
                    status
                    if let error {
                        Notice(symbol: "exclamationmark.triangle.fill", tint: .red, text: error)
                            .padding(.top, 16)
                    }
                    Spacer(minLength: 32)
                }
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .safeAreaInset(edge: .bottom) { actions }
        .padding(.horizontal, 28)
        .frame(maxWidth: 520)
    }

    @ViewBuilder private var status: some View {
        HStack(spacing: 8) {
            if let retryIn {
                Text("Trying again in \(retryIn) s")
                    .contentTransition(.numericText(countsDown: true))
            } else {
                ProgressView().controlSize(.small)
                Text("Trying again…")
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .animation(.default, value: retryIn)
        .accessibilityElement(children: .combine)
    }

    private var actions: some View {
        VStack(spacing: 10) {
            if !others.isEmpty {
                ForEach(others) { m in
                    Button { use(m) } label: {
                        Label("Open \(m.name.isEmpty ? "your other computer" : m.name)", systemImage: "desktopcomputer")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 34)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                }
                Button(action: talk) {
                    Label("Talk to pi", systemImage: "waveform")
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
            }
            Button {
                taps += 1
                retry()
            } label: {
                Label("Try again now", systemImage: "arrow.clockwise")
                    .font(.headline)
                    .foregroundStyle(Color.accentText)
                    .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .disabled(retryIn == nil)
            .sensoryFeedback(.impact(weight: .light), trigger: taps)
        }
        .padding(.top, 12)
        .padding(.bottom, 24)
        .background(Color.piBackground)
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
