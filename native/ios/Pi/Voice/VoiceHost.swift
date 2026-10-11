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
    /// Every entry point (bridge, intent, push) gets the same handoff: dictation is drained first.
    static func start(model: AppModel, agent: String, machine: String, dictation: DictationControl? = nil) async throws {
        await dictationToDrain(dictation).cancelIfActive()
        let e = model.voice
        if e.isOpen {
            await e.start(agent: agent, machine: machine)
            return
        }
        guard model.machines.contains(where: { $0.id == machine }) else { throw HubError.network("That computer isn't paired with this iPhone.") }
        guard await AVAudioApplication.requestRecordPermission() else {
            throw HubError.network("Microphone access is off. Turn it on in Settings.")
        }
        guard let core = await VoiceCore.load(origin: trustedCoreOrigin(model.primary?.origin)) else { throw HubError.network("Voice mode couldn't load.") }
        let fleet = LiveFleet(machines: model.machines)
        // 401 from a computer: the app's verified-removal path (asks the hub again, then forgets it).
        fleet.onUnauthorized = { [weak model] id in if let model { Task { await machineRejected(model, id) } } }
        e.attach(VoiceDeps(
            fleet: fleet,
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
        follow(model, e)
    }

    /// A running voice mode follows the app's machine list (added, removed, re-paired).
    private static func follow(_ model: AppModel, _ e: VoiceEngine) {
        withObservationTracking { _ = model.machines } onChange: { [weak model, weak e] in
            Task { @MainActor in
                guard let model, let e, e.isOpen else { return }
                e.machinesChanged(model.machines)
                follow(model, e)
            }
        }
    }

    /// Voice mode got 401 from a computer: forget it only if a fresh `hub` call confirms the removal
    /// (the same rule as BRIDGE.md removals), and only the credential that was checked.
    static func machineRejected(_ model: AppModel, _ id: String) async {
        guard let m = model.machines.first(where: { $0.id == id }), let c = try? HubClient(machine: m) else { return }
        do { _ = try await c.hub() } catch HubError.unauthorized { model.forget(m) } catch {}
    }

    static func dictationToDrain(_ d: DictationControl?) -> DictationControl { d ?? Dictation.shared }

    /// The hub's voice-core.js decides safety (destructive confirmations), so it is taken only over a
    /// transport that can't be tampered with on the way: HTTPS (e.g. Tailscale serve) or this device.
    /// Plain-HTTP LAN hubs use the copy bundled in the app.
    static func trustedCoreOrigin(_ origin: String?) -> String? {
        guard let origin, let url = URL(string: origin), let host = url.host()?.lowercased() else { return nil }
        if url.scheme?.lowercased() == "https" { return origin }
        return ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) ? origin : nil
    }
}
