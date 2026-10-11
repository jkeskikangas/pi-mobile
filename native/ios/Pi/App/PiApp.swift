import SwiftUI

@main
struct PiApp: App {
    @State private var model = AppModel()
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Color.accentColor)
                .onAppear { PushCenter.shared.attach(model) }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Color.piBackground.ignoresSafeArea()
            if let primary = model.primary {
                ShellView(machine: primary)
                    .id(primary.id + primary.d)
                    .transition(.opacity)
            } else {
                PairingView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.primary?.id)
        .task { await model.debugAutoPair() }
        .task { await VoiceActivityController.shared.debugFake() }
    }
}

extension Color {
    /// The web UI's `--bg` (light #f7f7f5, dark #0e0f11): native surfaces match it so nothing flashes.
    static let piBackground = Color("LaunchBackground")
    /// The web UI's `--accent-text`: white on the light accent, near-black on the dark one.
    static let accentText = Color("AccentText")
}

extension UIColor {
    static let piBackground = UIColor(named: "LaunchBackground") ?? .systemBackground
}
