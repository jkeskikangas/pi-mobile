import Foundation
import UIKit

/// What the voice engine needs from dictation: drop any take in progress before voice mode starts (BRIDGE.md `voice.start`).
@MainActor
protocol DictationControl: AnyObject {
    /// Stops and discards a recording (or a pending start/stop) without telling the page; no-op when idle.
    func cancelIfActive()
}

/// The audio side, swapped for a fake in tests.
@MainActor
protocol DictationRecorder: AnyObject {
    /// Called with a user-facing message when the system stops recording on its own.
    var onEnded: ((String) -> Void)? { get set }
    /// Input level 0…1 at ~20 Hz while recording.
    var onLevel: ((Double) -> Void)? { get set }
    func start() async throws
    func stop() async throws -> Data
    func cancel()
}

struct DictationError: LocalizedError {
    let message: String
    var settings = false
    var errorDescription: String? { message }
}

/// Composer dictation per BRIDGE.md: `dictation.start` / `.stop` / `.cancel` and `dictationEnded` / `level` back to the page.
@MainActor
final class Dictation: DictationControl {
    static let shared = Dictation(recorder: AudioRecorder())

    enum State: Equatable { case idle, starting, recording, stopping }
    private(set) var state: State = .idle
    /// Bumped by every cancel/end so late async results know their take was given up.
    private var take = 0
    private var startTask: Task<Void, Error>?
    private let recorder: DictationRecorder
    /// Runs JavaScript in the page (set by the web shell).
    var js: (String) -> Void = { _ in }
    var haptic: () -> Void = { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    /// Shown when the microphone is denied (offers Settings).
    var onDenied: @MainActor (String) -> Void = { Dictation.offerSettings($0) }

    init(recorder: DictationRecorder) {
        self.recorder = recorder
        recorder.onEnded = { [weak self] msg in self?.systemEnded(msg) }
        recorder.onLevel = { [weak self] x in
            guard let self, self.state == .recording else { return }
            self.js("window.PiNative.level && window.PiNative.level(\(String(format: "%.3f", x)))")
        }
    }

    func start() async throws {
        guard state == .idle else { throw DictationError(message: "already recording.") }
        state = .starting
        let mine = take
        let task = Task { try await recorder.start() }
        startTask = task
        do {
            try await task.value
        } catch {
            if take == mine { state = .idle }
            startTask = nil
            if let e = error as? DictationError, e.settings { onDenied(e.message) }
            throw error
        }
        startTask = nil
        // Cancelled (or ended) while starting: the take is gone; the web sends cancel anyway.
        guard take == mine else { recorder.cancel(); return }
        state = .recording
        haptic()
    }

    func stop() async throws -> Data {
        if state == .starting, let t = startTask { _ = try? await t.value; await Task.yield() }
        guard state == .recording else { throw DictationError(message: "nothing is being recorded.") }
        state = .stopping
        let mine = take
        haptic()
        let data: Data
        do { data = try await recorder.stop() } catch {
            if take == mine { state = .idle }
            throw error
        }
        guard take == mine else { throw DictationError(message: "cancelled.") }
        state = .idle
        return data
    }

    /// Idempotent: always succeeds.
    func cancel() {
        take += 1
        let was = state
        state = .idle
        if was == .recording || was == .stopping { recorder.cancel() }
        // .starting: start() cancels the recorder once it resolves.
    }

    func cancelIfActive() { if state != .idle { cancel() } }

    private func systemEnded(_ message: String) {
        guard state != .idle else { return }
        take += 1
        state = .idle
        let arg = String(decoding: (try? JSONEncoder().encode(message)) ?? Data("null".utf8), as: UTF8.self)
        js("window.PiNative.dictationEnded && window.PiNative.dictationEnded(\(arg))")
    }

    static func offerSettings(_ message: String) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard var top = scene?.keyWindow?.rootViewController else { return }
        while let p = top.presentedViewController { top = p }
        let a = UIAlertController(title: "Microphone is off", message: "Allow pi to use the microphone in Settings to dictate.", preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Not now", style: .cancel))
        a.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
        })
        top.present(a, animated: true)
    }
}
