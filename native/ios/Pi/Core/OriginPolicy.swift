import Foundation

/// Which hub addresses the app talks to (README → ATS): HTTPS only. The one exception is loopback
/// (127.0.0.1, localhost, ::1) over plain HTTP, so the simulator can reach the `npm run ui` fixture.
/// A plain-HTTP computer (LAN, Tailscale 100.x, .local) is refused with a sentence that says how to get
/// its secure address; one already paired stays in the list, shown as needing to pair again over HTTPS.
enum OriginPolicy {
    static let readme = "https://github.com/jkeskikangas/pi-mobile#lock-screen-notifications-and-https"
    static let plainHTTPMessage = "This computer needs its secure address. Install Tailscale on it and this iPhone, run /remote in pi there, and scan the new code (\(readme))."
    static let repairMessage = "This computer was paired over plain http://, which the app no longer uses. Pair it again with its secure address: install Tailscale, run /remote in pi there, and scan the new code."

    /// nil when the app may use `origin`, else the sentence to show.
    static func problem(_ origin: String) -> String? {
        guard let url = URL(string: origin), let scheme = url.scheme?.lowercased(), let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else {
            return "That computer's address isn't valid. Pair it again."
        }
        if scheme == "https" { return nil }
        guard scheme == "http" else { return "That computer's address isn't valid. Pair it again." }
        return isLoopback(host) ? nil : plainHTTPMessage
    }

    static func isLoopback(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }
}
