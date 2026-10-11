import Foundation
import JavaScriptCore

/// `web/voice-core.js` evaluated in JavaScriptCore (plans/native-apps.md D3): every decision voice
/// mode delegates to `PiVoiceCore` goes through here, never reimplemented in Swift. Loaded from the
/// hub (`GET /voice-core.js`, so it always matches the hub), else the copy bundled at build time.
@MainActor
final class VoiceCore {
    struct Command: Equatable, Sendable { var kind: String }
    /// `answerFor` result: `value` set (nil `value` with `answered` = cancel), or `needConfirm`, or `unclear`.
    struct Answer: Equatable, Sendable {
        var answered = false
        var value: JSON?
        var needConfirm: String?
        var option: String?
        var unclear = false
    }
    enum Match: Equatable, Sendable {
        case match(Int)
        case ambiguous([Int])
        case none
    }

    private let ctx: JSContext
    private let api: JSValue
    /// Where the script came from: "hub" or "bundle".
    let source: String
    let help: String
    let settings: [String]
    /// name → [[hz, ms, gain]]
    let earcons: [String: [[Double]]]

    init(script: String, source: String) throws {
        guard let ctx = JSContext() else { throw CoreError.load("no JavaScriptCore") }
        var thrown: String?
        ctx.exceptionHandler = { _, e in thrown = e?.toString() }
        ctx.evaluateScript(script)
        guard thrown == nil, let api = ctx.objectForKeyedSubscript("PiVoiceCore"), api.isObject, api.forProperty("parseCommand")?.isObject == true else {
            throw CoreError.load(thrown ?? "PiVoiceCore missing")
        }
        self.ctx = ctx
        self.api = api
        self.source = source
        help = api.forProperty("HELP")?.toString() ?? ""
        settings = (api.forProperty("SETTINGS")?.toArray() as? [String]) ?? []
        var e: [String: [[Double]]] = [:]
        if let obj = api.forProperty("EARCONS")?.toDictionary() as? [String: [[NSNumber]]] {
            for (k, v) in obj { e[k] = v.map { $0.map(\.doubleValue) } }
        }
        earcons = e
    }

    enum CoreError: Error, LocalizedError {
        case load(String)
        var errorDescription: String? { if case .load(let m) = self { "voice-core.js: \(m)" } else { nil } }
    }

    /// The bundled copy (copied from web/ by the pre-build script).
    static func bundled() throws -> VoiceCore {
        guard let url = Bundle.main.url(forResource: "voice-core", withExtension: "js"), let s = try? String(contentsOf: url, encoding: .utf8) else {
            throw CoreError.load("not bundled")
        }
        return try VoiceCore(script: s, source: "bundle")
    }

    /// The hub's copy, else the bundled one.
    static func load(origin: String?, session: URLSession = .shared) async -> VoiceCore? {
        if let origin, let url = URL(string: "\(origin)/voice-core.js") {
            var req = URLRequest(url: url, timeoutInterval: 5)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            if let (data, resp) = try? await session.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
               let s = String(data: data, encoding: .utf8), let core = try? VoiceCore(script: s, source: "hub") {
                return core
            }
        }
        return try? bundled()
    }

    // MARK: bridging
    private func js(_ v: JSON?) -> Any {
        guard let v else { return JSValue(undefinedIn: ctx) as Any }
        return v.foundation
    }

    private func call(_ name: String, _ args: [Any]) -> JSValue? {
        api.forProperty(name)?.call(withArguments: args)
    }

    private func json(_ v: JSValue?) -> JSON? {
        guard let v, !v.isUndefined else { return nil }
        if v.isNull { return .null }
        return JSON(any: v.toObject())
    }

    /// A prompt as `voice-core.js` expects it (title, message, kind, options).
    static func prompt(_ p: JSON) -> JSON { p }

    // MARK: PiVoiceCore
    func norm(_ s: String) -> String { call("norm", [s])?.toString() ?? "" }

    func parseCommand(_ text: String) -> Command? {
        guard let r = call("parseCommand", [text]), r.isObject, let k = r.forProperty("kind")?.toString() else { return nil }
        return Command(kind: k)
    }

    func answerFor(prompt: JSON, text: String) -> Answer {
        guard let r = call("answerFor", [prompt.foundation, text]), r.isObject else { return Answer(unclear: true) }
        var a = Answer()
        if r.forProperty("unclear")?.toBool() == true { a.unclear = true }
        if let w = r.forProperty("needConfirm"), !w.isUndefined { a.needConfirm = w.toString() }
        if let o = r.forProperty("option"), !o.isUndefined { a.option = o.toString() }
        // `{ value: undefined }` (cancel) has the key; `{ needConfirm }` does not.
        if r.hasProperty("value") { a.answered = true; a.value = json(r.forProperty("value")) }
        return a
    }

    func requestNames(prompt: JSON, said: String) -> Bool { call("requestNames", [prompt.foundation, said])?.toBool() ?? false }
    func isDestructive(_ prompt: JSON) -> Bool { call("isDestructive", [prompt.foundation])?.toBool() ?? false }
    func isBackchannel(_ text: String, answering: Bool = false) -> Bool { call("isBackchannel", [text, answering])?.toBool() ?? false }
    func isEcho(_ heard: String, _ spoken: String) -> Bool { call("isEcho", [heard, spoken])?.toBool() ?? false }
    func isSignificant(_ text: String) -> Bool { call("isSignificant", [text])?.toBool() ?? false }
    func speakPrompt(_ prompt: JSON, page: Int = 0) -> String { call("speakPrompt", [prompt.foundation, page])?.toString() ?? "" }
    func incomplete(_ text: String) -> Bool { call("incomplete", [text])?.toBool() ?? false }
    func chunks(_ text: String) -> [String] { (call("chunks", [text])?.toArray() as? [String]) ?? [] }

    /// `matchSession(list, said)`: list items `{ agent, name, cwd, task, machine }`; returns indices.
    func matchSession(_ list: [JSON], _ said: String) -> Match {
        guard let arr = JSValue(object: list.map(\.foundation), in: ctx) else { return .none }
        for (i, _) in list.enumerated() { arr.atIndex(i).setValue(i, forProperty: "__i") }
        guard let r = call("matchSession", [arr, said]), r.isObject else { return .none }
        if let m = r.forProperty("match"), m.isObject { return .match(Int(m.forProperty("__i").toInt32())) }
        if let a = r.forProperty("ambiguous"), a.isArray {
            let n = Int(a.forProperty("length").toInt32())
            return .ambiguous((0..<n).map { Int(a.atIndex($0).forProperty("__i").toInt32()) })
        }
        return .none
    }

    /// `new PiVoiceCore.Vad(opts)`.
    func vad(hangMs: Double? = nil, minSpeechMs: Double? = nil) -> Vad {
        var o: [String: Any] = [:]
        if let hangMs { o["hangMs"] = hangMs }
        if let minSpeechMs { o["minSpeechMs"] = minSpeechMs }
        let v = api.forProperty("Vad").construct(withArguments: [o])!
        return Vad(v)
    }

    @MainActor
    final class Vad {
        private let v: JSValue
        init(_ v: JSValue) { self.v = v }
        /// "start" | "end" | nil
        func feed(_ rms: Double, _ now: Double) -> String? {
            let r = v.invokeMethod("feed", withArguments: [rms, now])
            return r?.isString == true ? r?.toString() : nil
        }
        func threshold() -> Double { v.invokeMethod("threshold", withArguments: [])?.toDouble() ?? 1 }
        func setGain(_ g: Double) { v.invokeMethod("setGain", withArguments: [g]) }
        func extend(_ ms: Double) { v.invokeMethod("extend", withArguments: [ms]) }
    }
}
