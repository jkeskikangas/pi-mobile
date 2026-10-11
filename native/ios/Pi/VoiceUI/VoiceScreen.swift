import SwiftUI
import UIKit

/// Voice mode, full screen (plans/native-apps.md §8; mirrors `#voice` in `web/index.html` and the
/// `.voice` block in `web/app.css`): header, the circle (orb, state, hint), captions, pi's question,
/// and two labelled buttons, Mute and End.
struct VoiceScreen: View {
    @Bindable var engine: VoiceEngine
    @State private var showSessions = false
    @State private var showSettings = false
    @State private var middleHeight: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let (c1, _) = VoicePalette.pair(engine.state)
        GeometryReader { geo in
            VStack(spacing: 10) {
                header
                VoiceStage(engine: engine)
                    .frame(minHeight: engine.question == nil ? 220 : typeSize.isAccessibilitySize ? 0 : 150)
                    .layoutPriority(1)
                middle(maxHeight: geo.size.height * (engine.question == nil ? 0.32 : typeSize.isAccessibilitySize ? 0.68 : 0.56))
                controls
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 14)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background {
            ZStack {
                Color.piBackground
                // The state glow (`.voice` background): the state's colour at 16% fading into the page.
                RadialGradient(colors: [c1.opacity(0.16), c1.opacity(0)], center: UnitPoint(x: 0.5, y: 0.36), startRadius: 0, endRadius: 520)
            }
            .ignoresSafeArea()
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.6), value: engine.state)
        }
        .voiceHaptics(engine)
        // VoiceOver hears a new question or problem without hunting for it.
        .onChange(of: engine.question?.id) { _, id in
            guard id != nil, let q = engine.question else { return }
            AccessibilityNotification.Announcement("pi asks: \(q.title)").post()
        }
        .onChange(of: engine.note) { _, note in
            if !note.isEmpty { AccessibilityNotification.Announcement(note).post() }
        }
        .sheet(isPresented: $showSessions) { VoiceSessionSheet(engine: engine).presentationDetents([.medium, .large]) }
        .sheet(isPresented: $showSettings) { VoiceSettingsSheet(engine: engine).presentationDetents([.medium, .large]) }
        // Awake only while voice is on and the screen is up; locking is fine (the call continues).
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .onChange(of: scenePhase) { _, p in UIApplication.shared.isIdleTimerDisabled = p == .active }
        .accessibilityAction(.escape) { engine.stop() }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 8) {
            Button { showSessions = true } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 4) {
                            StatusDot(status: engine.sessionStatus).padding(.trailing, 6)
                            Text(engine.sessionName.isEmpty ? "Session" : engine.sessionName)
                                .font(.headline)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                        }
                        let sub = [engine.machineName, engine.sessionLine.isEmpty ? nil : engine.sessionLine].compactMap { $0 }.joined(separator: " · ")
                        if !sub.isEmpty {
                            Text(sub).font(.footnote).foregroundStyle(.secondary).lineLimit(1).monospacedDigit()
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel([engine.sessionName, engine.machineName, engine.sessionLine].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
            .accessibilityHint("Switch session")

            Button { showSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .background(VoicePalette.panel2, in: .circle)
            }
            .buttonStyle(PressScale(scale: 0.92))
            .accessibilityLabel("Voice settings")
        }
    }

    // MARK: captions, question, note

    private func middle(maxHeight: CGFloat) -> some View {
        ScrollView {
            VStack(spacing: 10) {
                VoiceCaptions(heard: engine.heard, said: engine.said, hidePi: engine.question != nil)
                    .frame(minHeight: engine.question == nil ? 88 : 0, alignment: .top)
                if let q = engine.question {
                    QuestionCard(question: q,
                                 // Only the question on screen is answered: a late tap on a card that
                                 // was just replaced does nothing.
                                 answer: { opt in _ = await engine.answer(opt, questionId: q.id) },
                                 cancelGrace: { engine.cancelGrace() },
                                 doItNow: { await engine.doItNow() })
                        .id(q.id) // a new question is a new card: no busy state or taps carried over
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                }
                if !engine.note.isEmpty {
                    Text(engine.note)
                        .font(.footnote)
                        .foregroundStyle(VoicePalette.warnText)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.bottom, 4)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { middleHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        // The question card's shadow isn't cut at the scroll edges.
        .scrollClipDisabled()
        .scrollIndicators(.hidden)
        .frame(height: min(middleHeight, maxHeight))
        .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: engine.question)
    }

    // MARK: controls

    private var controls: some View {
        HStack(spacing: 56) {
            VoiceRoundButton(title: engine.muted ? "Unmute" : "Mute",
                             systemImage: engine.muted ? "mic.slash.fill" : "mic.fill",
                             face: engine.muted ? Color.primary : VoicePalette.panel2,
                             ink: engine.muted ? Color.piBackground : Color.primary) { engine.toggleMute() }
                .accessibilityLabel("Mute")
                .accessibilityValue(engine.muted ? "On" : "Off")
                .accessibilityAddTraits(.isToggle)
            VoiceRoundButton(title: "End", systemImage: "xmark", face: VoicePalette.danger, ink: .white) { engine.stop() }
                .accessibilityLabel("End voice mode")
        }
        .padding(.top, 4)
    }
}

/// The circle: one big push-to-talk target holding the orb, the state word and the hint.
struct VoiceStage: View {
    let engine: VoiceEngine
    /// The web's `HOLD_MS`: longer than this is a hold (let go to finish), shorter is a tap.
    static let holdSeconds = 0.35
    @State private var downAt: Date?
    @State private var startedTurn = false
    /// The finger slid off the circle during this press.
    @State private var left = false
    @State private var bounds = CGRect.zero
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Accessibility text sizes with a question on screen: the card needs the room, so the circle keeps
    /// just the state word (the orb is decorative and the card says how to answer).
    private var compact: Bool { engine.question != nil && typeSize.isAccessibilitySize }

    var body: some View {
        VStack(spacing: 6) {
            if !compact {
                OrbView(state: engine.state, level: level, holding: engine.holding)
                    .overlay {
                        if engine.state == .paused {
                            Image(systemName: "mic.slash")
                                .font(.system(size: 30, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.85))
                                .transition(.opacity)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            }
            Text(engine.label.isEmpty ? " " : engine.label)
                .font(.system(.title, weight: .semibold))
                .tracking(-0.3)
                .multilineTextAlignment(.center)
                .contentTransition(reduceMotion ? .identity : .opacity)
                .fixedSize(horizontal: false, vertical: true)
            if !compact {
                Text(engine.hint.isEmpty ? " " : engine.hint)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .monospacedDigit()
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .fixedSize(horizontal: false, vertical: false)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(.rect(cornerRadius: 24))
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .local) } action: { bounds = $0 }
        .gesture(press)
        .onDisappear { cancelPress() }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: engine.label)
        // VoiceOver: one element that names the action; activation is a tap.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(engine.stageAction)
        .accessibilityValue([engine.state == .speaking ? "pi is speaking" : engine.label, engine.hint].filter { !$0.isEmpty }.joined(separator: ". "))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { engine.tap() }
    }

    private var level: Double {
        switch engine.state {
        case .listening, .hearing: engine.levels.mine
        case .speaking: engine.levels.pi
        default: 0
        }
    }

    /// Hold while you talk, or tap to start and stop (`pressStart`/`pressEnd`); a press that didn't
    /// start a turn is a tap (interrupt, unmute, retry). Sliding off the circle cancels a tap; a turn
    /// already started ends as on release (the web's `pointercancel`), so the mic is never left held.
    private var press: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { v in
                if downAt == nil {
                    downAt = .now
                    left = false
                    startedTurn = engine.pressStart()
                    if startedTurn { VoiceHaptics.press() }
                    return
                }
                if !left && !bounds.insetBy(dx: -32, dy: -32).contains(v.location) {
                    left = true
                    finishPress(inside: false)
                }
            }
            .onEnded { v in
                if left { left = false; downAt = nil; return }
                finishPress(inside: bounds.insetBy(dx: -32, dy: -32).contains(v.location))
            }
    }

    private func finishPress(inside: Bool) {
        let held = downAt.map { Date.now.timeIntervalSince($0) >= Self.holdSeconds } ?? false
        if !left { downAt = nil }
        if startedTurn {
            startedTurn = false
            engine.pressEnd(held: held || !inside)
            VoiceHaptics.release()
        } else if inside {
            VoiceHaptics.press()
            engine.tap()
        }
    }

    /// The screen went away mid-press: give the floor back.
    func cancelPress() {
        if startedTurn { startedTurn = false; engine.pressEnd(held: true) }
        downAt = nil
        left = false
    }
}

/// Captions: what you said ("You ·") and what pi says, live as words arrive; clamped, never scrolled.
/// Live text is told apart by colour (contrast-tested `--text-2`), never by dimming.
struct VoiceCaptions: View {
    let heard: VoiceCaption
    let said: VoiceCaption
    let hidePi: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !heard.text.isEmpty {
                (Text("You · ").font(.footnote.weight(.bold)).foregroundColor(VoicePalette.youText)
                    + Text(heard.text).font(.subheadline).foregroundColor(VoicePalette.text2))
                    .lineLimit(2)
                    .accessibilityLabel("You said: \(heard.text)")
            }
            if !said.text.isEmpty && !hidePi {
                Text(said.text)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(said.live ? VoicePalette.text2 : Color.primary)
                    .lineLimit(4)
                    .accessibilityLabel("pi: \(said.text)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: said.text.isEmpty)
    }
}

/// A big labelled control (`.v-btn`): a 68–72 pt face and a label under it.
struct VoiceRoundButton: View {
    let title: String
    let systemImage: String
    let face: Color
    let ink: Color
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 26, weight: .semibold))
                    .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    .foregroundStyle(ink)
                    .frame(width: faceSize, height: faceSize)
                    .background(face, in: .circle)
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(minWidth: 72)
            .contentShape(.rect)
        }
        .buttonStyle(PressScale(scale: 0.94))
    }

    /// 72 pt on tall phones (the web's `min-height: 760px`), 68 pt otherwise.
    private var faceSize: CGFloat { UIScreen.main.bounds.height >= 760 ? 72 : 68 }
}

// MARK: presenting

/// Shows voice mode full screen while the engine is on (`isOpen`); the shell applies it once.
struct VoiceScreenPresenter: ViewModifier {
    let engine: VoiceEngine?

    func body(content: Content) -> some View {
        content.fullScreenCover(isPresented: Binding(get: { engine?.isOpen ?? false }, set: { if !$0 { engine?.stop() } })) {
            if let engine { VoiceScreen(engine: engine) }
        }
    }
}

extension View {
    /// Present the voice screen whenever `engine` is running.
    func voiceScreen(_ engine: VoiceEngine?) -> some View { modifier(VoiceScreenPresenter(engine: engine)) }
}
