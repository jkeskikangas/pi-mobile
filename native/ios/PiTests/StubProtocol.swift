import Foundation

/// URLProtocol stub: records requests and answers from a handler. One handler per test.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Response { var status = 200; var body = Data(); var chunks: [Data] = [] }
    nonisolated(unsafe) static var handler: ((URLRequest, Data) -> Response)?
    nonisolated(unsafe) static var requests: [(URLRequest, Data)] = []
    static let lock = NSLock()

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: c)
    }

    static func reset(_ h: @escaping (URLRequest, Data) -> Response) {
        lock.withLock { handler = h; requests = [] }
    }

    static var recorded: [(URLRequest, Data)] { lock.withLock { requests } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        let h = Self.lock.withLock { Self.requests.append((request, body)); return Self.handler }
        let r = h?(request, body) ?? Response(status: 500)
        let resp = HTTPURLResponse(url: request.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        for c in r.chunks { client?.urlProtocol(self, didLoad: c) }
        if !r.body.isEmpty { client?.urlProtocol(self, didLoad: r.body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
