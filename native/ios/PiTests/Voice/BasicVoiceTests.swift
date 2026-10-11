import XCTest
@testable import Pi

final class BasicVoiceTests: XCTestCase {
    func testDownsamplePicksIndices() {
        let s = (0..<12).map(Float.init)
        XCTAssertEqual(BasicVoice.downsample(s, from: 48000), [0, 3, 6, 9])
        XCTAssertEqual(BasicVoice.downsample(s, from: 24000, to: 16000), [0, 1, 3, 4, 6, 7, 9, 10])
        XCTAssertEqual(BasicVoice.downsample(s, from: 16000), s)
    }

    func testWavHeader() {
        let d = BasicVoice.wav([0, 1, -1, 2], rate: 16000)
        XCTAssertEqual(d.count, 44 + 8)
        func str(_ o: Int, _ n: Int) -> String { String(decoding: d[o..<o + n], as: UTF8.self) }
        func u32(_ o: Int) -> UInt32 { d[o..<o + 4].enumerated().reduce(0) { $0 | UInt32($1.element) << (8 * $1.offset) } }
        func i16(_ o: Int) -> Int16 { Int16(bitPattern: UInt16(d[o]) | UInt16(d[o + 1]) << 8) }
        XCTAssertEqual(str(0, 4), "RIFF")
        XCTAssertEqual(u32(4), 36 + 8)
        XCTAssertEqual(str(8, 8), "WAVEfmt ")
        XCTAssertEqual(u32(16), 16)
        XCTAssertEqual(u32(24), 16000)
        XCTAssertEqual(u32(28), 32000)
        XCTAssertEqual(str(36, 4), "data")
        XCTAssertEqual(u32(40), 8)
        XCTAssertEqual([i16(44), i16(46), i16(48), i16(50)], [0, 0x7fff, -0x7fff, 0x7fff])
    }
}
