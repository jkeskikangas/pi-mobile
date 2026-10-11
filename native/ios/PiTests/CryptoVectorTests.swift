import XCTest
@testable import Pi

/// `native/fixtures/crypto-vectors.json` comes from tweetnacl-js (`npm run vectors`): byte-for-byte compatibility.
final class CryptoVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct Valid: Decodable { let name: String; let value: JSON; let json: String; let sealed: String }
        struct Invalid: Decodable { let name: String; let key: String; let sealed: String }
        let key: String
        let nonce: String
        let valid: [Valid]
        let invalid: [Invalid]
    }

    func load() throws -> Vectors {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "crypto-vectors", withExtension: "json"))
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSealMatchesTweetnaclByteForByte() throws {
        let v = try load()
        let key = try XCTUnwrap(Base64URL.decode(v.key))
        let nonce = try XCTUnwrap(Base64URL.decode(v.nonce))
        XCTAssertEqual(v.valid.count, 5)
        for c in v.valid {
            XCTAssertEqual(Envelope.seal(key: key, plaintext: Data(c.json.utf8), nonce: nonce), c.sealed, c.name)
        }
    }

    func testOpenReadsEveryVector() throws {
        let v = try load()
        let key = try XCTUnwrap(Base64URL.decode(v.key))
        for c in v.valid {
            XCTAssertEqual(Envelope.open(key: key, sealed: c.sealed), c.value, c.name)
        }
    }

    func testOpenRejectsInvalidInput() throws {
        let v = try load()
        XCTAssertEqual(v.invalid.count, 3)
        for c in v.invalid {
            XCTAssertNil(Envelope.openData(key: try XCTUnwrap(Base64URL.decode(c.key)), sealed: c.sealed), c.name)
        }
        XCTAssertNil(Envelope.openData(key: Data(count: 32), sealed: "not-base64!!"))
    }

    func testSealRoundTripsWithFreshNonces() throws {
        let key = Data((0..<32).map { UInt8($0) })
        let a = try Envelope.seal(key: key, value: ["m": "hub", "t": 1])
        let b = try Envelope.seal(key: key, value: ["m": "hub", "t": 1])
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(Envelope.open(key: key, sealed: a), ["m": "hub", "t": 1])
    }

    func testBase64URL() {
        let d = Data([0xfb, 0xff, 0xfe, 0x00])
        XCTAssertEqual(Base64URL.encode(d), "-__-AA")
        XCTAssertEqual(Base64URL.decode("-__-AA"), d)
        XCTAssertNil(Base64URL.decode("a=b"))
    }
}
