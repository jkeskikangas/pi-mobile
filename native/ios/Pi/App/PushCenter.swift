import UIKit
import UserNotifications

/// iPhone notifications through APNs (plans/native-apps.md §11): permission when the user turns them on
/// in the web's Notifications section (BRIDGE.md `push.enable`), never at first launch; the device token
/// goes to every paired computer (each sends its own); taps open the session, "Answer by voice" starts voice mode.
@MainActor
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    weak var model: AppModel?
    /// Sandbox tokens unless the build signs for production APNs: the same `PI_APS_ENVIRONMENT` that goes
    /// into the entitlements reaches Info.plist as `PiAPSEnvironment`.
    nonisolated static let sandbox = Bundle.main.object(forInfoDictionaryKey: "PiAPSEnvironment") as? String != "production"
    /// The build signs with the push entitlement (`PI_PUSH=YES` reaches Info.plist as `PiPushAvailable`).
    /// Without it the web's Notifications row says push isn't in this build instead of offering it.
    nonisolated static let available = (Bundle.main.object(forInfoDictionaryKey: "PiPushAvailable") as? String)?.uppercased() == "YES"

    private let defaults: UserDefaults
    private var tokenWaiters: [UUID: CheckedContinuation<String?, Never>] = [:]
    /// A notification opened before the app model existed (cold launch from a tap).
    private var pendingOpen: (action: String, agent: String, machine: String, entry: String)?
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

    /// At launch (app delegate), before any notification response can arrive.
    func install() {
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
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { PushCenter.shared.machinesChanged() }
        }
    }

    func attach(_ model: AppModel) {
        guard self.model == nil else { return }
        self.model = model
        if let o = pendingOpen { pendingOpen = nil; Task { await opened(action: o.action, agent: o.agent, machine: o.machine, entry: o.entry) } }
        Task {
            // A token can change (restore, reinstall): ask for it on every launch; every computer hears again.
            if Self.available, enabled, await permission() == "granted" { registered = []; UIApplication.shared.registerForRemoteNotifications() }
            await reconcile()
        }
    }

    func didRegister(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        if hex != token { registered = [] }
        token = hex
        resolveTokens(hex)
        Task { await reconcile() }
    }

    func didFail(_ error: Error) {
        resolveTokens(nil)
    }

    private func resolveTokens(_ hex: String?) {
        let w = tokenWaiters; tokenWaiters = [:]
        w.values.forEach { $0.resume(returning: hex) }
    }

    /// Waits for APNs' answer; this wait's own timeout never cuts short a later one.
    private func awaitToken(timeout: Duration = .seconds(15)) async -> String? {
        let id = UUID()
        return await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            tokenWaiters[id] = c
            UIApplication.shared.registerForRemoteNotifications()
            Task {
                try? await Task.sleep(for: timeout)
                self.tokenWaiters.removeValue(forKey: id)?.resume(returning: nil)
            }
        }
    }

    // MARK: Computers

    /// What each computer should hold, from its own `hub` answer (`apnsOn`): this phone's token while
    /// notifications are on, nothing while off. Runs at launch, on foreground, when a computer is added and
    /// after a change, so an off that a sleeping computer missed is retried until it lands.
    func reconcile() async {
        guard let model else { return }
        for m in model.machines {
            guard let c = model.client(for: m), let hub = try? await c.rpc("hub") else { continue }
            let held = hub["apnsOn"]?.bool ?? false
            // A build without push never enrols, and takes back an enrolment an earlier build left behind.
            if let p = Self.action(enabled: Self.available && enabled, token: token, held: held, sent: registered.contains(tag(m))) {
                guard (try? await c.rpc("push", p)) != nil else { continue }
                if p["apns"]?.isNull == true { registered.remove(tag(m)) } else { registered.insert(tag(m)) }
            }
        }
    }

    private func tag(_ m: Machine) -> String { "\(m.id)|\(m.d)|\(token ?? "")" }

    /// The `push` RPC that brings one computer in line, or nil when it already is.
    nonisolated static func action(enabled: Bool, token: String?, held: Bool, sent: Bool) -> JSON? {
        if enabled, let token {
            return held && sent ? nil : ["apns": ["token": .string(token), "sandbox": .bool(sandbox)]]
        }
        return held ? ["apns": .null] : nil
    }

    func machinesChanged() {
        Task { await reconcile() }
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
        return ["on": .bool(Self.available && enabled && p == "granted" && token != nil), "permission": .string(p), "available": .bool(Self.available)]
    }

    struct Failure: LocalizedError {
        var errorDescription: String?
    }

    func enable(_ on: Bool) async throws -> JSON {
        guard on else {
            // Persisted first: computers that miss the off now get it at the next reconcile.
            enabled = false
            await reconcile()
            return await status()
        }
        guard Self.available else { throw Failure(errorDescription: "Notifications aren't available in this build of the app.") }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else { throw Failure(errorDescription: "Notifications are off for pi. Turn them on in Settings.") }
        enabled = true
        if await awaitToken() == nil {
            enabled = false
            // Free provisioning has no push entitlement (README → Push).
            throw Failure(errorDescription: "This build of the app can't get notifications (it needs a paid developer team).")
        }
        await reconcile()
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
        guard let model else { pendingOpen = (action, agent, machine, entry); return }
        focus(machine: machine, agent: agent)
        guard action == PushContent.answerByVoice, !entry.isEmpty else { return }
        do { try await VoiceHost.start(model: model, agent: agent, machine: entry, dictation: Dictation.shared) } catch {
            await report("Voice mode didn't start: \(error.localizedDescription)")
        }
    }

    /// An alert when the app is on screen, a local notification otherwise.
    private func report(_ text: String) async {
        if UIApplication.shared.applicationState == .active,
           let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first {
            let top = sequence(first: root, next: \.presentedViewController).reversed().first ?? root
            let a = UIAlertController(title: nil, message: text, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default))
            top.present(a, animated: true)
            return
        }
        let c = UNMutableNotificationContent()
        c.title = "pi"
        c.body = text
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
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
    /// The delegate and the "Answer by voice" category exist before a cold-launch tap is delivered.
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { PushCenter.shared.install() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushCenter.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        MainActor.assumeIsolated { PushCenter.shared.didFail(error) }
    }
}
