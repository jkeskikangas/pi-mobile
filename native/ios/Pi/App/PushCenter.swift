import UIKit
import UserNotifications

/// iPhone notifications through APNs (plans/native-apps.md §11): permission when the user turns them on
/// in the web's Notifications section (BRIDGE.md `push.enable`), never at first launch; the device token
/// goes to every paired computer (each sends its own); taps open the session, "Answer by voice" starts voice mode.
@MainActor
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    weak var model: AppModel?
    /// Development builds get sandbox tokens.
    #if DEBUG
    static let sandbox = true
    #else
    static let sandbox = false
    #endif

    private let defaults: UserDefaults
    private var tokenWaiters: [CheckedContinuation<String?, Never>] = []
    /// Evaluates JavaScript in the loaded page (nil while it loads).
    private var js: ((String) -> Void)?
    private var pendingFocus: (machine: String, agent: String)?

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// The user turned notifications on in the app.
    private(set) var enabled: Bool {
        get { defaults.bool(forKey: "pi-push-on") }
        set { defaults.set(newValue, forKey: "pi-push-on") }
    }
    private(set) var token: String? {
        get { defaults.string(forKey: "pi-push-token") }
        set { defaults.set(newValue, forKey: "pi-push-token") }
    }
    /// `entry id|device id|token` already sent: a new computer or a new token registers again.
    private var registered: Set<String> {
        get { Set(defaults.stringArray(forKey: "pi-push-registered") ?? []) }
        set { defaults.set(Array(newValue), forKey: "pi-push-registered") }
    }

    // MARK: Launch

    func attach(_ model: AppModel) {
        guard self.model == nil else { return }
        self.model = model
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let voice = UNNotificationAction(identifier: PushContent.answerByVoice, title: "Answer by voice", options: [.foreground], icon: UNNotificationActionIcon(systemImageName: "waveform"))
        center.setNotificationCategories([UNNotificationCategory(identifier: PushContent.asksCategory, actions: [voice], intentIdentifiers: [])])
        #if DEBUG
        // The simulator never runs a Notification Service Extension for `xcrun simctl push`, so
        // `-PiPushDemo <APNs JSON>` runs the extension's rewrite here and shows the result as a local notification.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-PiPushDemo"), i + 1 < args.count,
           let payload = (try? JSONSerialization.jsonObject(with: Data(args[i + 1].utf8))) as? [String: Any] {
            let c = UNMutableNotificationContent()
            let aps = payload["aps"] as? [String: Any]
            let alert = aps?["alert"] as? [String: Any]
            c.title = alert?["title"] as? String ?? ""
            c.body = alert?["body"] as? String ?? ""
            c.threadIdentifier = aps?["thread-id"] as? String ?? ""
            c.sound = .default
            c.userInfo = payload
            let out = PushContent.rewrite(c, machines: MachineStore().load())
            Task {
                try? await Task.sleep(for: .seconds(3))
                try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: out, trigger: nil))
            }
        }
        #endif
        guard enabled else { return }
        Task {
            // A token can change (restore, reinstall): ask for it on every launch; every computer hears again.
            if await permission() == "granted" { registered = []; UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func didRegister(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        if hex != token { registered = [] }
        token = hex
        resolveToken(hex)
        if enabled { Task { await registerAll() } }
    }

    func didFail(_ error: Error) {
        resolveToken(nil)
    }

    private func resolveToken(_ hex: String?) {
        let w = tokenWaiters; tokenWaiters = []
        w.forEach { $0.resume(returning: hex) }
    }

    // MARK: Computers

    /// Sends the token to each computer that doesn't have it yet (called when a computer is added).
    func registerAll() async {
        guard enabled, let token, let model else { return }
        for m in model.machines {
            let tag = "\(m.id)|\(m.d)|\(token)"
            guard !registered.contains(tag), let c = model.client(for: m) else { continue }
            if (try? await c.rpc("push", ["apns": ["token": .string(token), "sandbox": .bool(Self.sandbox)]])) != nil { registered.insert(tag) }
        }
    }

    func machinesChanged() {
        guard enabled else { return }
        Task { await registerAll() }
    }

    // MARK: The web's Notifications row (BRIDGE.md `push.status`, `push.enable`)

    func permission() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: "granted"
        case .denied: "denied"
        default: "default"
        }
    }

    func status() async -> JSON {
        let p = await permission()
        return ["on": .bool(enabled && p == "granted" && token != nil), "permission": .string(p)]
    }

    struct Failure: LocalizedError {
        var errorDescription: String?
    }

    func enable(_ on: Bool) async throws -> JSON {
        guard on else {
            enabled = false
            registered = []
            if let model {
                for m in model.machines { _ = try? await model.client(for: m)?.rpc("push", ["apns": .null]) }
            }
            return await status()
        }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { throw Failure(errorDescription: "Notifications are off for pi. Turn them on in Settings.") }
        enabled = true
        let hex = await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            tokenWaiters.append(c)
            UIApplication.shared.registerForRemoteNotifications()
            Task { try? await Task.sleep(for: .seconds(15)); self.resolveToken(nil) }
        }
        if hex == nil {
            enabled = false
            // Free provisioning has no push entitlement (README → Push).
            throw Failure(errorDescription: "This build of the app can't get notifications (it needs a paid developer team).")
        }
        await registerAll()
        return await status()
    }

    // MARK: Opening a notification

    /// The page finished loading: run what waited for it.
    func pageLoaded(_ eval: @escaping (String) -> Void) {
        js = eval
        if let f = pendingFocus { pendingFocus = nil; focus(machine: f.machine, agent: f.agent) }
    }

    func pageUnloaded() { js = nil }

    /// Tells the web to show a session (BRIDGE.md `focus`), now or when the page has loaded.
    func focus(machine: String, agent: String) {
        guard !agent.isEmpty else { return }
        guard let js else { pendingFocus = (machine, agent); return }
        func lit(_ s: String) -> String { String(decoding: (try? JSON.string(s).data()) ?? Data("\"\"".utf8), as: UTF8.self) }
        js("window.PiNative?.focus?.(\(lit(machine)), \(lit(agent)))")
    }

    func opened(action: String, agent: String, machine: String, entry: String) async {
        guard !agent.isEmpty else { return }
        focus(machine: machine, agent: agent)
        if action == PushContent.answerByVoice, !entry.isEmpty {
            if let model { try? await VoiceHost.start(model: model, agent: agent, machine: entry, dictation: Dictation.shared) }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let s = { (k: String) in info[k] as? String ?? "" }
        let (action, agent, machine, entry) = (response.actionIdentifier, s("agent"), s("machine"), s("entry"))
        await opened(action: action, agent: agent, machine: machine, entry: entry)
    }
}

/// APNs callbacks arrive on the app delegate.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushCenter.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { PushCenter.shared.didFail(error) }
    }
}
