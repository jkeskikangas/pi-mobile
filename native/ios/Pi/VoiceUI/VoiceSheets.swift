import AVFoundation
import SwiftUI

/// The session switcher: every reachable session, grouped as the web's (`urgency()` in `web/app.js`).
struct VoiceSessionSheet: View {
    let engine: VoiceEngine
    @Environment(\.dismiss) private var dismiss

    private static func urgency(_ s: VoiceSessionItem) -> Int { s.waiting > 0 || s.status == "waiting" ? 0 : s.status == "working" ? 1 : 2 }

    var body: some View {
        NavigationStack {
            List {
                ForEach([(0, "Needs you"), (1, "Working"), (2, "Idle")], id: \.0) { rank, title in
                    let items = engine.sessions.filter { Self.urgency($0) == rank }
                    if !items.isEmpty {
                        Section(title) { ForEach(items) { row($0) } }
                    }
                }
            }
            .overlay { if engine.sessions.isEmpty { ContentUnavailableView("No other sessions", systemImage: "rectangle.stack") } }
            .navigationTitle("Talk to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func row(_ s: VoiceSessionItem) -> some View {
        let current = s.agent == engine.agent && s.machine == engine.machineId
        let sub = [s.machineName, s.waiting > 0 ? "Needs you" : s.status == "waiting" ? "Waiting for input in the terminal" : s.status == "working" ? "Working" : nil]
            .compactMap { $0 }.joined(separator: " · ")
        return Button {
            if !current { engine.switchSession(agent: s.agent, machine: s.machine) }
            dismiss()
        } label: {
            HStack(spacing: 12) {
                StatusDot(status: Self.urgency(s) == 0 ? "waiting" : s.status)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.name.isEmpty ? "Session" : s.name).foregroundStyle(.primary)
                    if !sub.isEmpty { Text(sub).font(.subheadline).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 8)
                if current { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.tint) }
            }
            .contentShape(.rect)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

/// The voice picker (`voiceSheet()`): the computer's personas; choosing one plays its sample.
struct VoicePersonaList: View {
    let engine: VoiceEngine
    /// The voice being switched to (a realtime call redials), and the last pick waiting behind it:
    /// rapid picks coalesce to the latest instead of overlapping redials.
    @State private var applying: String?
    @State private var pending: String?
    @State private var local = LocalSample()

    private func choose(_ id: String) {
        if applying != nil { pending = id; return }
        Task {
            var next: String? = id
            while let id = next {
                applying = id
                if engine.engineKind == nil {
                    // No call to speak through (connecting or the mic failed): the phone's closest voice, as the web does.
                    engine.settings.personas.first { $0.id == id }.map { local.play($0) }
                }
                await engine.setPersona(id)
                next = pending
                pending = nil
            }
            applying = nil
        }
    }

    var body: some View {
        let s = engine.settings
        List {
            Section {
                ForEach(s.personas) { p in
                    Button { choose(p.id) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).foregroundStyle(.primary)
                                Text(p.blurb).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            if applying == p.id {
                                ProgressView().accessibilityLabel("Switching voice")
                            } else if p.id == s.persona {
                                Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.tint)
                            }
                        }
                        .contentShape(.rect)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(p.id == s.persona ? .isSelected : [])
                    .accessibilityHint("Plays a sample")
                }
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if !engine.note.isEmpty { Text(engine.note).foregroundStyle(VoicePalette.warnText) }
                    Text("Tap a voice to hear it. It changes how pi sounds, never what it says or how much.")
                }
            }
        }
        .navigationTitle("Voice")
    }
}

/// A persona sample in the phone's closest voice (the web's `playSample` fallback).
@MainActor final class LocalSample {
    private let synth = AVSpeechSynthesizer()

    func play(_ p: VoicePersona) {
        synth.stopSpeaking(at: .immediate)
        let u = AVSpeechUtterance(string: VoiceEngine.sampleLine(p))
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
        u.voice = voices.first { v in p.phonePrefer.contains { v.name.localizedCaseInsensitiveContains($0) } }
            ?? voices.max { $0.quality.rawValue < $1.quality.rawValue }
        u.pitchMultiplier = Float(p.phonePitch)
        u.rate = AVSpeechUtteranceDefaultSpeechRate * Float(p.rate)
        synth.speak(u)
    }
}

/// The header's status dot (`.dot` classes): idle green, working violet, needs you amber.
struct StatusDot: View {
    let status: String
    var body: some View {
        Circle()
            .fill(fill)
            .frame(width: 10, height: 10)
            .accessibilityHidden(true)
    }

    private var fill: Color {
        switch status {
        case "waiting": VoicePalette.needs
        case "working": Color(light: 0x7C5CFF, dark: 0xB39BFF)
        case "idle": Color(light: 0x15803D, dark: 0x4ADE80)
        default: VoicePalette.fill2
        }
    }
}

/// Voice settings (`#vSettings`): Eyes-free | Can glance, Open mic | Push to talk, the voice, and why
/// basic voice is in use when it is.
struct VoiceSettingsSheet: View {
    let engine: VoiceEngine
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRevoke = false

    var body: some View {
        let s = engine.settings
        NavigationStack {
            Form {
                Section {
                    Picker("How much pi says", selection: Binding(get: { s.attention }, set: { engine.applySetting($0 == .glance ? .glance : .eyesFree) })) {
                        Text("Eyes-free").tag(VoiceAttention.eyesBusy)
                        Text("Can glance").tag(VoiceAttention.glance)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                } header: {
                    Text("How much pi says")
                } footer: {
                    Text(s.attention == .eyesBusy ? "Shortest answers, nothing visual: driving, running, cycling." : "A little more detail; you can look at the screen.")
                }
                Section {
                    Picker("Taking turns", selection: Binding(get: { s.turns }, set: { engine.applySetting($0 == .tap ? .pushToTalk : .openMic) })) {
                        Text("Open mic").tag(VoiceTurns.open)
                        Text("Push to talk").tag(VoiceTurns.tap)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                } header: {
                    Text("Taking turns")
                } footer: {
                    Text(s.turns == .open ? "Just talk; pi notices when you're done." : "Hold the circle while you talk, or tap to start and stop. For wind, traffic and noise.")
                }
                Section {
                    NavigationLink {
                        VoicePersonaList(engine: engine)
                    } label: {
                        let p = s.personas.first { $0.id == s.persona } ?? s.personas.first
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p?.name ?? "Choose a voice")
                                Text(p?.blurb ?? "How pi sounds").font(.subheadline).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "waveform") }
                    }
                    .disabled(s.personas.isEmpty)
                } header: {
                    Text("Voice")
                } footer: {
                    Text("\(engine.engineKind == .basic ? "Basic voice: recognition on your computer and a spoken brief\(s.basicReason.map { ", because realtime voice is unavailable (\($0))" } ?? "")." : "Realtime voice.") You can also say “push to talk”, “open mic”, “eyes free” or “I can glance”.")
                }
                Section {
                    Button(role: .destructive) { confirmRevoke = true } label: {
                        Label("Stop sharing my voice", systemImage: "hand.raised")
                    }
                    .confirmationDialog("Stop sharing your voice?", isPresented: $confirmRevoke, titleVisibility: .visible) {
                        Button("Stop sharing and end voice mode", role: .destructive) {
                            AIConsent.shared.revoke()
                            Dictation.shared.consentRevoked()
                            dismiss()
                            engine.stop()
                        }
                    } message: {
                        Text("Voice mode ends now. pi asks again before voice mode or dictation next time.")
                    }
                    Link(destination: PiLinks.privacy) {
                        Label("Privacy policy", systemImage: "lock.doc")
                    }
                } header: {
                    Text("Privacy")
                } footer: {
                    Text("Your voice goes to OpenAI for realtime speech and to your computer. The developer of pi never receives it.")
                }
            }
            .navigationTitle("Voice settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
