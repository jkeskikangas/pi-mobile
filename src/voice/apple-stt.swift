// On-device speech recognition for pi-mobile with Apple's SpeechAnalyzer (macOS 26+).
// No account, no network after the one-time model download, contextual strings for code names.
//
//   apple-stt file <audio-file> [--words a,b,c] [--locale en-US]
//       → {"text": "…", "locale": "en_US"}
//   apple-stt stream [--rate 16000] [--words …] [--locale …]   (s16le mono PCM on stdin)
//       → JSON lines: {"partial": "…"} while speaking, {"final": "…"} per settled segment,
//         {"done": true, "text": "…"} after stdin closes
//   apple-stt check [--locale …]  → {"ok": true, "locale": "…"} (installs the model if needed)

import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
		FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
	}
}

func fail(_ message: String) -> Never {
	emit(["error": message])
	exit(1)
}

struct Options {
	var mode = ""
	var path = ""
	var words: [String] = []
	var locale: String?
	var rate = 16000.0
}

func parse() -> Options {
	var o = Options()
	var args = Array(CommandLine.arguments.dropFirst())
	guard !args.isEmpty else { fail("usage: apple-stt file|stream|check …") }
	o.mode = args.removeFirst()
	while !args.isEmpty {
		let a = args.removeFirst()
		switch a {
		case "--words": o.words = (args.isEmpty ? "" : args.removeFirst()).split(separator: "\n").map(String.init).filter { !$0.isEmpty }
		case "--locale": o.locale = args.isEmpty ? nil : args.removeFirst()
		case "--rate": o.rate = Double(args.isEmpty ? "16000" : args.removeFirst()) ?? 16000
		default: o.path = a
		}
	}
	return o
}

func prepare(_ o: Options) async throws -> (SpeechAnalyzer, SpeechTranscriber, Locale) {
	let wanted = o.locale.map { Locale(identifier: $0) } ?? Locale.current
	guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
		fail("speech recognition does not support \(wanted.identifier) on this Mac")
	}
	let live = o.mode == "stream"
	let transcriber = SpeechTranscriber(
		locale: locale,
		transcriptionOptions: [],
		reportingOptions: live ? [.volatileResults] : [],
		attributeOptions: []
	)
	if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
		try await request.downloadAndInstall()
	}
	let analyzer = SpeechAnalyzer(modules: [transcriber])
	if !o.words.isEmpty {
		let context = AnalysisContext()
		context.contextualStrings[.general] = Array(o.words.prefix(100))
		try await analyzer.setContext(context)
	}
	return (analyzer, transcriber, locale)
}

func runFile(_ o: Options) async throws {
	let (analyzer, transcriber, locale) = try await prepare(o)
	let file = try AVAudioFile(forReading: URL(fileURLWithPath: o.path))
	async let text: String = transcriber.results.reduce("") { $0 + String($1.text.characters) }
	if let last = try await analyzer.analyzeSequence(from: file) {
		try await analyzer.finalizeAndFinish(through: last)
	} else {
		await analyzer.cancelAndFinishNow()
	}
	emit(["text": try await text.trimmingCharacters(in: .whitespacesAndNewlines), "locale": locale.identifier])
}

func runStream(_ o: Options) async throws {
	let (analyzer, transcriber, locale) = try await prepare(o)
	guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { fail("no audio format") }
	let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: o.rate, channels: 1, interleaved: true)!
	guard let converter = AVAudioConverter(from: source, to: target) else { fail("cannot convert audio") }
	let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream()

	let reader = Task {
		var finals = ""
		for try await r in transcriber.results {
			let t = String(r.text.characters)
			if r.isFinal {
				finals += t
				emit(["final": t.trimmingCharacters(in: .whitespaces)])
			} else {
				emit(["partial": (finals + t).trimmingCharacters(in: .whitespaces)])
			}
		}
		return finals
	}

	try await analyzer.start(inputSequence: inputs)

	let stdin = FileHandle.standardInput
	var pending = Data()
	while true {
		let chunk = stdin.availableData
		if chunk.isEmpty { break }
		pending.append(chunk)
		let frames = pending.count / 2
		if frames < 1600 { continue }
		let bytes = frames * 2
		guard let inBuf = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(frames)) else { continue }
		inBuf.frameLength = AVAudioFrameCount(frames)
		pending.withUnsafeBytes { raw in
			memcpy(inBuf.int16ChannelData![0], raw.baseAddress!, bytes)
		}
		pending.removeFirst(bytes)
		let capacity = AVAudioFrameCount(Double(frames) * target.sampleRate / source.sampleRate) + 32
		guard let outBuf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { continue }
		var fed = false
		var err: NSError?
		converter.convert(to: outBuf, error: &err) { _, status in
			if fed {
				status.pointee = .noDataNow
				return nil
			}
			fed = true
			status.pointee = .haveData
			return inBuf
		}
		if err == nil && outBuf.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: outBuf)) }
	}
	continuation.finish()
	try await analyzer.finalizeAndFinishThroughEndOfInput()
	let text = try await reader.value
	emit(["done": true, "text": text.trimmingCharacters(in: .whitespacesAndNewlines), "locale": locale.identifier])
}

@main
struct AppleSTT {
	static func main() async {
		let o = parse()
		do {
			switch o.mode {
			case "file": try await runFile(o)
			case "stream": try await runStream(o)
			case "check":
				let (_, _, locale) = try await prepare(o)
				emit(["ok": true, "locale": locale.identifier])
			default: fail("unknown mode \(o.mode)")
			}
		} catch {
			fail("\(error.localizedDescription)")
		}
	}
}
