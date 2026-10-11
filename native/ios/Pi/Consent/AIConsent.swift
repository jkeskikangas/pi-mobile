import SwiftUI
import UIKit

/// Links the app shows (privacy policy in the consent sheet, pairing screen and voice settings).
enum PiLinks {
    static let privacy = URL(string: "https://github.com/jkeskikangas/pi-mobile/blob/main/PRIVACY.md")!
    static let openAIPrivacy = URL(string: "https://openai.com/policies/privacy-policy/")!
}

/// The user's OK to send their voice to third parties (App Review guideline 5.1.2(i)): asked once, before
/// the first voice mode or dictation, with a native sheet that names who gets what (`ConsentSheet`).
/// Stored as the version of the recipients the user agreed to; bump `version` whenever that list changes
/// and everyone is asked again. Revoked from voice settings or the web menu (BRIDGE.md `consent.*`).
@MainActor
final class AIConsent {
    static let shared = AIConsent()
    /// 1: voice → OpenAI (realtime) + your computer; dictation → your computer → its transcription provider.
    /// 2: also session context to the realtime model, basic voice's speech services, dictation's AI tidy-up.
    static let version = 2
    static let key = "pi-ai-consent"

    enum Purpose: Sendable { case voice, dictation }

    struct Declined: LocalizedError {
        let purpose: Purpose
        var errorDescription: String? {
            purpose == .voice ? "Voice mode needs your OK to send your voice. Try again to see the details."
                : "Dictation needs your OK to send audio to your computer. Try again to see the details."
        }
    }

    /// The app isn't on screen (a Siri or Action button start): the question can't be asked there.
    struct NeedsApp: LocalizedError {
        var errorDescription: String? { "Open pi to allow voice mode first." }
    }

    private let defaults: UserDefaults
    /// Shows the sheet and returns the choice; replaced in tests.
    var ask: @MainActor (Purpose) async -> Bool = { await ConsentPresenter.ask($0) }
    /// Whether a sheet can be shown now.
    var canAsk: @MainActor () -> Bool = { UIApplication.shared.applicationState != .background }
    private var asking: Task<Bool, Never>?

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var granted: Bool { defaults.integer(forKey: Self.key) == Self.version }

    func grant() { defaults.set(Self.version, forKey: Self.key) }

    func revoke() { defaults.removeObject(forKey: Self.key) }

    /// Returns once the user has agreed; throws `Declined` (Not now) or `NeedsApp` (in the background).
    /// Concurrent callers share one sheet.
    func ensure(_ purpose: Purpose) async throws {
        if granted { return }
        guard canAsk() else { throw NeedsApp() }
        let task = asking ?? Task { await ask(purpose) }
        asking = task
        let ok = await task.value
        asking = nil
        if ok { grant() } else { throw Declined(purpose: purpose) }
    }
}

/// Presents `ConsentSheet` over whatever is on screen (the web shell, the pairing screen) from any entry point.
@MainActor
enum ConsentPresenter {
    static func ask(_ purpose: AIConsent.Purpose) async -> Bool {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let root = scene?.keyWindow?.rootViewController else { return false }
        let top = sequence(first: root, next: \.presentedViewController).reversed().first ?? root
        return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            var done = false
            var host: UIHostingController<ConsentSheet>?
            let finish: (Bool) -> Void = { ok in
                guard !done else { return }
                done = true
                host?.dismiss(animated: true)
                c.resume(returning: ok)
            }
            let h = UIHostingController(rootView: ConsentSheet(purpose: purpose, onChoice: finish))
            host = h
            h.isModalInPresentation = true // a choice is needed: Allow or Not now
            if let sheet = h.sheetPresentationController {
                sheet.detents = [.large()]
                sheet.prefersGrabberVisible = false
            }
            top.present(h, animated: true)
        }
    }
}
