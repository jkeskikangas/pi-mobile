import Foundation
import Security

/// Generic-password items, readable after first unlock so voice keeps working when the phone locks
/// mid-session. Uses the shared access group (widgets, later the notification extension) when the
/// build is entitled to it, and the app's own group otherwise (unsigned simulator test runs).
struct Keychain: Sendable {
    var service = "pi-mobile"
    var accessGroup: String? = Keychain.sharedGroup
    /// Retry without the group when this build isn't entitled to it.
    var fallback = true

    static let sharedGroup: String? = {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "PiKeychainGroup") as? String, !g.isEmpty, !g.hasPrefix("$(") else { return nil }
        return g
    }()

    private func query(_ account: String, group: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    /// errSecMissingEntitlement: this build may not use the shared group; fall back to the default one.
    private func withGroup<T>(_ body: (String?) -> (OSStatus, T)) -> (OSStatus, T) {
        let r = body(accessGroup)
        if r.0 == errSecMissingEntitlement, accessGroup != nil, fallback { return body(nil) }
        return r
    }

    func data(_ account: String) -> Data? {
        let (status, data): (OSStatus, Data?) = withGroup { group in
            var q = query(account, group: group)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            let s = SecItemCopyMatching(q as CFDictionary, &out)
            return (s, out as? Data)
        }
        return status == errSecSuccess ? data : nil
    }

    @discardableResult
    func set(_ data: Data?, for account: String) -> Bool {
        guard let data else { return remove(account) }
        let (status, _): (OSStatus, Void) = withGroup { group in
            let q = query(account, group: group)
            let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
            var s = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
            if s == errSecItemNotFound { s = SecItemAdd(q.merging(attrs) { $1 } as CFDictionary, nil) }
            return (s, ())
        }
        return status == errSecSuccess
    }

    @discardableResult
    func remove(_ account: String) -> Bool {
        let (status, _): (OSStatus, Void) = withGroup { group in (SecItemDelete(query(account, group: group) as CFDictionary), ()) }
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// The phone's computers, `[{ id, name, origin, d, k, … }]` in the Keychain (plans/native-apps.md §1).
struct MachineStore: Sendable {
    var keychain = Keychain()
    static let account = "machines"
    /// The single pairing from before several machines (`{ origin, d, k, role, host }`); migrated on load.
    static let legacyAccount = "device"

    func load() -> [Machine] {
        if let data = keychain.data(Self.account), let list = try? JSONDecoder().decode([Machine].self, from: data) { return list }
        guard let data = keychain.data(Self.legacyAccount), let old = try? JSON.parse(data),
              let d = old["d"]?.string, let k = old["k"]?.string, let origin = old["origin"]?.string else { return [] }
        let migrated = [Machine(name: old["host"]?.string ?? "", origin: origin, d: d, k: k, primary: true, added: 0)]
        // Keep the old entry unless the new one is safely written.
        if (try? save(migrated)) != nil { keychain.remove(Self.legacyAccount) }
        return migrated
    }

    struct SaveFailed: Error {}

    /// Throws when the Keychain refuses the write: callers must not report success (pairing codes are single use).
    func save(_ machines: [Machine]) throws {
        let data = machines.isEmpty ? nil : try JSONEncoder().encode(machines)
        guard keychain.set(data, for: Self.account) else { throw SaveFailed() }
    }

    func clear() {
        keychain.remove(Self.account)
        keychain.remove(Self.legacyAccount)
    }

    /// Adds a freshly paired computer. Pairing from the app replaces the primary, as `web/app.js` does.
    func adding(_ m: Machine, to list: [Machine]) -> [Machine] {
        var out = list.filter { !($0.primary && m.primary) && $0.d != m.d && !(m.machine != "" && $0.machine == m.machine) }
        if m.primary { out.insert(m, at: 0) } else { out.append(m) }
        return out
    }
}
