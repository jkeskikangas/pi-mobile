import Foundation

/// Which hub addresses the app talks to (README → ATS). HTTPS anywhere; plain HTTP only where
/// `NSAllowsLocalNetworking` (the app's only ATS exception) lets it through: this device, a private LAN
/// (10/8, 172.16/12, 192.168/16), link-local, `*.local` and single-label names (e.g. a MagicDNS short name).
/// Tailscale's 100.64/10 addresses are *not* covered (checked in the simulator: ATS blocks
/// `http://100.x`), so those need the Tailscale HTTPS address. Anything else on plain HTTP would fail
/// later with an opaque error; this says why up front.
enum OriginPolicy {
    static let plainHTTPMessage = "This address uses plain http://, which the app only allows on your home network. Use your computer's Tailscale HTTPS address (https://….ts.net) instead: set it up with /remote there and scan the new code."

    /// nil when the app may use `origin`, else the sentence to show.
    static func problem(_ origin: String) -> String? {
        guard let url = URL(string: origin), let scheme = url.scheme?.lowercased(), let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else {
            return "That computer's address isn't valid. Pair it again."
        }
        if scheme == "https" { return nil }
        guard scheme == "http" else { return "That computer's address isn't valid. Pair it again." }
        return isLocal(host) ? nil : plainHTTPMessage
    }

    static func isLocal(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if host == "localhost" || host.hasSuffix(".local") || host.hasSuffix(".localhost") { return true }
        if let v4 = ipv4(host) {
            let (a, b) = (v4[0], v4[1])
            return a == 127 || a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168)
                || (a == 169 && b == 254)
        }
        if host.contains(":") {
            // IPv6: loopback and link-local (fe80::/10) only; unique-local (incl. Tailscale's fd7a::) isn't known to pass ATS.
            if host == "::1" { return true }
            let first = host.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) ?? ""
            guard let w = UInt16(first, radix: 16) else { return false }
            return (w & 0xFFC0) == 0xFE80
        }
        // A single-label name (e.g. a MagicDNS short name) only resolves on your own network.
        return !host.contains(".")
    }

    private static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let n = parts.compactMap { Int($0) }
        guard n.count == 4, n.allSatisfy({ (0...255).contains($0) }) else { return nil }
        return n
    }
}
