import Foundation
import UserNotifications

/// The sealed APNs alert from `src/apns.ts`: Apple sees `{ aps: { alert: { title: "pi", body: "New activity" } }, sealed }`;
/// `sealed` holds `{ title, body, agent, machine }` sealed to this phone's device key on the sending computer.
/// Shared by the app and the Notification Service Extension (PiNotifications), which rewrites the text.
enum PushContent {
    /// Urgent notifications (pi asks something) offer "Answer by voice".
    static let asksCategory = "pi.asks"
    static let answerByVoice = "pi.answer-by-voice"

    struct Opened: Equatable, Sendable {
        var title: String
        var body: String
        var agent: String
        /// The sending computer's id (its hub's machine id).
        var machine: String
        /// This phone's machines-list entry whose key opened it (BRIDGE.md `voice.start` `machine`).
        var entry: String
    }

    /// The payload does not say which computer sent it (Apple would see that), so each stored key is tried:
    /// secretbox authenticates, a wrong key never opens.
    static func open(sealed: String, machines: [Machine]) -> Opened? {
        for m in machines {
            guard let key = m.key, let v = Envelope.open(key: key, sealed: sealed), v.object != nil else { continue }
            let machine = v["machine"]?.string ?? m.machine
            // Prefer the entry that names this computer, if one has the same key.
            let entry = machines.first { $0.machine == machine && !machine.isEmpty && $0.k == m.k }?.id ?? m.id
            return Opened(title: v["title"]?.string ?? "pi", body: v["body"]?.string ?? "", agent: v["agent"]?.string ?? "", machine: machine, entry: entry)
        }
        return nil
    }

    /// The notification with the real title and body; the generic text stays when nothing opens it
    /// (key missing, computer forgotten, garbled payload).
    static func rewrite(_ content: UNNotificationContent, machines: [Machine]) -> UNNotificationContent {
        let out = (content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        guard let sealed = content.userInfo["sealed"] as? String, let o = open(sealed: sealed, machines: machines) else { return out }
        out.title = o.title.isEmpty ? "pi" : o.title
        if !o.body.isEmpty { out.body = o.body }
        var info = out.userInfo
        info["sealed"] = nil
        info["agent"] = o.agent
        info["machine"] = o.machine
        info["entry"] = o.entry
        out.userInfo = info
        if !o.agent.isEmpty { out.threadIdentifier = o.agent }
        let aps = content.userInfo["aps"] as? [String: Any]
        if aps?["interruption-level"] as? String == "time-sensitive", !o.agent.isEmpty { out.categoryIdentifier = asksCategory }
        return out
    }
}
