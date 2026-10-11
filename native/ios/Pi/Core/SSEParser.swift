import Foundation

/// Incremental Server-Sent Events parser (WHATWG rules): CR, LF or CRLF line ends, `:` comments,
/// multi-line `data:` joined with "\n", one leading space stripped from values, dispatch on a blank line.
/// Fed byte by byte so chunk boundaries never matter.
struct SSEParser: Sendable {
    enum Item: Equatable, Sendable {
        case comment(String)
        case message(event: String?, data: String)
    }

    private var line: [UInt8] = []
    private var data: [String] = []
    private var event: String?
    private var afterCR = false

    mutating func feed(_ byte: UInt8) -> Item? {
        if afterCR {
            afterCR = false
            if byte == 0x0A { return nil } // the LF of a CRLF
        }
        switch byte {
        case 0x0D:
            afterCR = true
            return endLine()
        case 0x0A:
            return endLine()
        default:
            line.append(byte)
            return nil
        }
    }

    mutating func feed(_ bytes: some Sequence<UInt8>) -> [Item] {
        bytes.compactMap { feed($0) }
    }

    private mutating func endLine() -> Item? {
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            defer { data = []; event = nil }
            return data.isEmpty ? nil : .message(event: event, data: data.joined(separator: "\n"))
        }
        let text = String(decoding: line, as: UTF8.self)
        if text.hasPrefix(":") { return .comment(String(text.dropFirst()).trimmingPrefix(" ").description) }
        let field: Substring
        var value: Substring
        if let i = text.firstIndex(of: ":") {
            field = text[..<i]
            value = text[text.index(after: i)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "data": data.append(String(value))
        case "event": event = String(value)
        default: break // id, retry: the hub resumes with `since` instead
        }
        return nil
    }
}
