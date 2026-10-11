import Foundation

/// Who may deactivate the shared audio session: the last of voice mode and dictation to take it.
/// Voice mode releases the session a moment after End (so its "off" sound plays out); if dictation
/// took the session meanwhile, that late release must not cut dictation's microphone.
@MainActor
final class AudioOwner {
    static let shared = AudioOwner()
    private var current = 0

    /// Takes the session; returns this holder's token.
    func claim() -> Int {
        current += 1
        return current
    }

    /// True while nobody claimed the session after `token`.
    func owns(_ token: Int?) -> Bool { token == current }
}
