import SwiftUI

/// Who receives your voice, before the first voice mode or dictation (AIConsent). Plain words, the
/// recipients named, Allow / Not now. Works at every Dynamic Type size (scrolls, buttons stay pinned).
struct ConsentSheet: View {
    let purpose: AIConsent.Purpose
    let onChoice: (Bool) -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: "waveform.circle.fill")
                        .font(.system(size: 44))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                    Text("Where your voice goes")
                        .font(.title.bold())
                        .accessibilityAddTraits(.isHeader)
                    Text(purpose == .voice ? "Before voice mode starts, here is who hears you." : "Before dictation starts, here is who hears you.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                VStack(spacing: 10) {
                    Recipient(
                        symbol: "bubble.left.and.text.bubble.right.fill",
                        title: "Voice mode",
                        text: "Your voice streams straight to **OpenAI** for realtime speech, using your computer's ChatGPT sign-in or API key. Your computer also gets what you say and pi's replies."
                    )
                    Recipient(
                        symbol: "mic.fill",
                        title: "Dictation",
                        text: "The recording goes to **your computer**, which turns it into text with the speech provider it is set up with. That may be OpenAI."
                    )
                    Recipient(
                        symbol: "lock.fill",
                        title: "Nobody else",
                        text: "The developer of pi never receives your audio or text. Traffic between this iPhone and your computer is end-to-end encrypted."
                    )
                }
                Text("OpenAI handles audio under its own privacy policy. You can turn this off any time in voice settings or the menu.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Link("pi's privacy policy", destination: PiLinks.privacy)
                    Link("OpenAI's privacy policy", destination: PiLinks.openAIPrivacy)
                }
                .font(.footnote.weight(.medium))
            }
            .padding(.horizontal, 24)
            .padding(.top, 28)
            .padding(.bottom, 16)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 4) {
                Button { onChoice(true) } label: {
                    Text("Allow")
                        .font(.headline)
                        .foregroundStyle(Color.accentText)
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .accessibilityHint("Lets voice mode and dictation send audio as described")
                Button("Not now") { onChoice(false) }
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
        .background(Color.piBackground.ignoresSafeArea())
    }
}

private struct Recipient: View {
    let symbol: String
    let title: String
    let text: LocalizedStringKey
    @ScaledMetric(relativeTo: .title3) private var iconWidth = 30.0

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: iconWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
