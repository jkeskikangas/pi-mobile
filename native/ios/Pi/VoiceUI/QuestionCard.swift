import SwiftUI

/// pi's question, as the app's question card (`.prompt`, `renderAsk` in `web/voice.js`): "pi asks",
/// the title, the message and tap answers (destructive in red); during the undo window "Going ahead",
/// a shrinking amber bar, Cancel and Do it now.
struct QuestionCard: View {
    let question: VoiceQuestion
    let answer: (VoiceQuestion.Option) async -> Void
    let cancelGrace: () -> Void
    let doItNow: () async -> Void
    @State private var busy = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let grace = question.grace { graceBody(grace) } else { askBody }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(VoicePalette.surface)
                .shadow(color: .black.opacity(0.16), radius: 20, y: 8)
        }
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(VoicePalette.warnLine))
        .disabled(busy)
        .accessibilityElement(children: .contain)
    }

    private func eyebrow(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(.caption.weight(.bold))
            .foregroundStyle(VoicePalette.warnText)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private var askBody: some View {
        eyebrow("pi asks")
        Text(question.title)
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
        if let message = question.message, !message.isEmpty {
            Text(message)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(6)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VoicePalette.codeBg, in: .rect(cornerRadius: 10, style: .continuous))
                .padding(.top, 8)
        }
        if question.options.isEmpty {
            Text("Say your answer.").font(.subheadline).padding(.top, 8)
        } else {
            let actions = question.options.filter { !$0.ghost }
            let ghosts = question.options.filter(\.ghost)
            Group {
                if question.kind == "confirm" && actions.count == 2 {
                    if typeSize.isAccessibilitySize {
                        VStack(spacing: 8) { ForEach(actions, id: \.self) { button($0) } }
                    } else {
                        HStack(spacing: 8) { ForEach(actions, id: \.self) { button($0) } }
                    }
                } else {
                    VStack(spacing: 8) { ForEach(actions, id: \.self) { button($0, leading: true) } }
                }
            }
            .padding(.top, 14)
            ForEach(ghosts, id: \.self) { o in
                Button(o.label) { send(o) }
                    .font(.body.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.top, 4)
            }
        }
    }

    private func button(_ o: VoiceQuestion.Option, leading: Bool = false) -> some View {
        let fill: Color = o.destructive ? VoicePalette.danger : o.primary ? .accentColor : VoicePalette.panel2
        let ink: Color = o.destructive ? .white : o.primary ? .accentText : .primary
        return Button { send(o) } label: {
            Text(o.label)
                .font(.body.weight(leading && !o.primary && !o.destructive ? .medium : .semibold))
                .multilineTextAlignment(leading ? .leading : .center)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: leading ? .leading : .center)
                .padding(.horizontal, 16).padding(.vertical, 4)
                .foregroundStyle(ink)
                .background(fill, in: .rect(cornerRadius: 12, style: .continuous))
                .contentShape(.rect)
        }
        .buttonStyle(PressScale())
        .accessibilityHint(o.destructive ? "Destructive" : "")
    }

    private func send(_ o: VoiceQuestion.Option) {
        busy = true
        Task { await answer(o); busy = false }
    }

    @ViewBuilder private func graceBody(_ grace: VoiceQuestion.Grace) -> some View {
        eyebrow("Going ahead")
        Text(question.title.replacingOccurrences(of: #"\?\s*$"#, with: "", options: .regularExpression))
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
        // The bar shrinks smoothly; the seconds re-render with it.
        TimelineView(.animation(minimumInterval: reduceMotion ? 1 : 1 / 30)) { tl in
            VStack(alignment: .leading, spacing: 12) {
                Text(grace.text(tl.date))
                    .font(.subheadline)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                GeometryReader { geo in
                    Capsule().fill(VoicePalette.fill2)
                        .overlay(alignment: .leading) {
                            Capsule().fill(VoicePalette.needs).frame(width: geo.size.width * grace.fraction(tl.date))
                        }
                }
                .frame(height: 6)
                .accessibilityHidden(true)
            }
            .padding(.top, 8)
        }
        Group {
            if typeSize.isAccessibilitySize { VStack(spacing: 8) { graceButtons } } else { HStack(spacing: 8) { graceButtons } }
        }
        .buttonStyle(PressScale())
        .padding(.top, 14)
    }

    @ViewBuilder private var graceButtons: some View {
        Button { cancelGrace() } label: {
            Text("Cancel").font(.body.weight(.semibold)).lineLimit(1).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(Color.accentText).background(Color.accentColor, in: .rect(cornerRadius: 12, style: .continuous))
        }
        Button { busy = true; Task { await doItNow(); busy = false } } label: {
            Text("Do it now").font(.body.weight(.semibold)).lineLimit(1).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(.primary).background(VoicePalette.panel2, in: .rect(cornerRadius: 12, style: .continuous))
        }
    }
}

/// The web's `:active` scale for big buttons.
/// With Reduce Motion the press is a dim instead of a scale.
struct PressScale: ButtonStyle {
    var scale: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View { Pressed(configuration: configuration, scale: scale) }

    private struct Pressed: View {
        let configuration: Configuration
        let scale: CGFloat
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
                .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
        }
    }
}
