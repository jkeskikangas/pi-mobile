import Foundation

/// Which hub addresses the app talks to (README → ATS): HTTPS only. The one exception is loopback
/// (127.0.0.1, localhost, ::1) over plain HTTP, so the simulator can reach the `npm run ui` fixture.
/// A plain-HTTP computer (LAN, Tailscale 100.x, .local) is refused with a sentence that says how to get
/// its secure address.
/// Hub requests never follow a redirect off their own origin (a hub could otherwise send the phone to a
/// plain-HTTP or foreign address); the 3xx response is returned as is and fails as an HTTP error.
final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = RedirectGuard()

    static func allows(from: URL?, to: URL?) -> Bool {
        guard let from, let to, OriginPolicy.problem(to.absoluteString) == nil else { return false }
        return from.scheme?.lowercased() == to.scheme?.lowercased() && from.host()?.lowercased() == to.host()?.lowercased() && from.port == to.port
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        Self.allows(from: task.originalRequest?.url, to: request.url) ? request : nil
    }
}

enum OriginPolicy {
    static let readme = "https://github.com/jkeskikangas/pi-mobile#https-and-lock-screen-notifications"
    static let plainHTTPMessage = "This computer needs its secure address. Install Tailscale on it and this iPhone, run /remote in pi there, and scan the new code (\(readme))."

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
