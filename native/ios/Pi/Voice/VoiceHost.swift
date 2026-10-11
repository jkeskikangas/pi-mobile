import Foundation
import AVFAudio
import Observation

extension Notification.Name {
    /// Voice mode closed: the web shell calls `window.PiNative.voiceClosed()` (BRIDGE.md).
    static let piVoiceClosed = Notification.Name("piVoiceClosed")
}

/// Owns the one voice engine of the app and starts it for the bridge's `voice.start` (BRIDGE.md):
/// idempotent (an open voice mode just follows the new session), cancels dictation first.
@MainActor
enum VoiceHost {
    static func start(model: AppModel, agent: String, machine: String, dictation: DictationControl?) async throws {
        await dictation?.cancelIfActive()
        let e = model.voice
        if e.isOpen {
            await e.start(agent: agent, machine: machine)
            return
        }
        guard model.machines.contains(where: { $0.id == machine }) else { throw HubError.network("That computer isn't paired with this iPhone.") }
        guard await AVAudioApplication.requestRecordPermission() else {
            throw HubError.network("Microphone access is off. Turn it on in Settings.")
        }
        guard let core = await VoiceCore.load(origin: model.primary?.origin) else { throw HubError.network("Voice mode couldn't load.") }
        e.attach(VoiceDeps(
            fleet: LiveFleet(machines: model.machines),
            core: core,
            makeRealtime: { RealtimeClient() },
            makeBasic: { BasicVoice() },
            earcons: Earcons(steps: core.earcons),
            audioSession: AudioSessionController(),
            prefs: model.prefs
        ))
        e.onClose = { NotificationCenter.default.post(name: .piVoiceClosed, object: nil) }
        // Presented as soon as `isOpen` flips; connecting continues behind the screen.
        Task { await e.start(agent: agent, machine: machine) }
    }
}
