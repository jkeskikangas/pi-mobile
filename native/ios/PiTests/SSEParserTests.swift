import XCTest
@testable import Pi

final class SSEParserTests: XCTestCase {
    func parse(_ chunks: [String]) -> [SSEParser.Item] {
        var p = SSEParser()
        return chunks.flatMap { p.feed(Array($0.utf8)) }
    }

    func testMessagesAndComments() {
        XCTAssertEqual(parse([": ping\n\ndata: abc\n\n"]), [.comment("ping"), .message(event: nil, data: "abc")])
    }

    func testChunkBoundariesAnywhere() {
        let text = "event: x\ndata: hello\n\n: ping\n\ndata: world\n\n"
        let whole = parse([text])
        for split in 1..<text.utf8.count {
            let bytes = Array(text.utf8)
            var p = SSEParser()
            let out = p.feed(bytes[..<split]) + p.feed(bytes[split...])
            XCTAssertEqual(out, whole, "split at \(split)")
        }
        XCTAssertEqual(whole, [.message(event: "x", data: "hello"), .comment("ping"), .message(event: nil, data: "world")])
    }

    func testMultiLineDataAndLineEndings() {
        XCTAssertEqual(parse(["data: a\r\ndata:b\r\n\r\n"]), [.message(event: nil, data: "a\nb")])
        XCTAssertEqual(parse(["data: a\r", "\r"]), [.message(event: nil, data: "a")])
    }

    func testIgnoresUnknownFieldsAndEmptyEvents() {
        XCTAssertEqual(parse(["id: 4\nretry: 10\n\n\n\ndata\n\n"]), [.message(event: nil, data: "")])
    }

    func testIncompleteMessageIsNotDispatched() {
        XCTAssertEqual(parse(["data: partial\n"]), [])
    }
}
