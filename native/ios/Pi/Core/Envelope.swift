import Foundation
import Sodium

/// base64url without padding, as `Buffer.toString("base64url")` writes it.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard s.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" }) else { return nil }
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        return Data(base64Encoded: s)
    }
}

/// The end-to-end envelope shared with `src/crypto.ts`: NaCl secretbox (XSalsa20-Poly1305),
/// `base64url(nonce24 ‖ box)`. Transport (LAN HTTP, Tailscale) never sees plaintext.
enum Envelope {
    nonisolated(unsafe) private static let sodium = Sodium()
    static let keyBytes = 32
    static let nonceBytes = 24
    static let overhead = 16

    /// Seals raw UTF-8 JSON text. `nonce` is for test vectors only: never reuse one in real traffic.
    static func seal(key: Data, plaintext: Data, nonce: Data? = nil) -> String {
        precondition(key.count == keyBytes, "secretbox key must be 32 bytes")
        let n = nonce.map { Array($0) } ?? sodium.secretBox.nonce()
        let box = sodium.secretBox.seal(message: Array(plaintext), secretKey: Array(key), nonce: n) ?? []
        return Base64URL.encode(Data(n + box))
    }

    static func seal(key: Data, value: JSON) throws -> String {
        seal(key: key, plaintext: try value.data())
    }

    /// The plaintext, or nil when forged, garbled or sealed with another key.
    static func openData(key: Data, sealed: String) -> Data? {
        guard key.count == keyBytes, let raw = Base64URL.decode(sealed), raw.count > nonceBytes + overhead else { return nil }
        let bytes = Array(raw)
        let nonce = Array(bytes[..<nonceBytes])
        let box = Array(bytes[nonceBytes...])
        return sodium.secretBox.open(authenticatedCipherText: box, secretKey: Array(key), nonce: nonce).map { Data($0) }
    }

    static func open(key: Data, sealed: String) -> JSON? {
        openData(key: key, sealed: sealed).flatMap { try? JSON.parse($0) }
    }

    static func open<T: Decodable>(_ type: T.Type, key: Data, sealed: String) -> T? {
        openData(key: key, sealed: sealed).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}
