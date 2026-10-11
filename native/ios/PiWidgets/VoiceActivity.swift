import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The voice Live Activity: Lock Screen / StandBy banner and the Dynamic Island.
struct VoiceActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivityAttributes.self) { ctx in
            VoiceLockScreen(state: ctx.state)
                .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { ctx in
            let s = ctx.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        VoiceDot(state: s, size: 14)
                        Text(s.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VoiceTimer(state: s).font(.subheadline).foregroundStyle(.secondary).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 10) {
                        VoiceText(state: s, prominent: true)
                        VoiceButtons(muted: s.muted)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                VoiceDot(state: s, size: 12, glow: false).padding(.leading, 2)
            } compactTrailing: {
                Text(s.question != nil ? "Needs you" : s.muted ? "Mic off" : s.label)
                    .font(.caption.weight(.medium)).lineLimit(1).frame(maxWidth: 76)
                    .foregroundStyle(s.palette.0)
            } minimal: {
                VoiceDot(state: s, size: 12, glow: false)
            }
            .keylineTint(s.palette.0)
        }
    }
}

/// The orb as a dot: a gradient in the state's colours, a slashed mic when muted. Flat in always-on.
struct VoiceDot: View {
    var state: VoiceActivityAttributes.ContentState
    var size: CGFloat
    /// Off in the Dynamic Island, where the glow is clipped by the region.
    var glow = true
    @Environment(\.isLuminanceReduced) private var dim

    var body: some View {
        let (a, b) = state.palette
        ZStack {
            Circle().fill(LinearGradient(colors: [a, b], startPoint: .topLeading, endPoint: .bottomTrailing))
                .opacity(dim ? 0.6 : 1)
            if state.muted {
                Image(systemName: "mic.slash.fill").font(.system(size: size * 0.55, weight: .bold)).foregroundStyle(.black.opacity(0.75))
            }
        }
        .frame(width: size, height: size)
        .shadow(color: dim || !glow ? .clear : a.opacity(0.6), radius: size / 4)
        .accessibilityHidden(true)
    }
}

struct VoiceTimer: View {
    var state: VoiceActivityAttributes.ContentState
    var body: some View {
        Text(timerInterval: state.started...Date.distantFuture, countsDown: false)
            .monospacedDigit().multilineTextAlignment(.trailing).frame(maxWidth: 64, alignment: .trailing)
    }
}

/// The state word, and the question underneath while pi is asking.
struct VoiceText: View {
    var state: VoiceActivityAttributes.ContentState
    var prominent = false
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(state.label).font(prominent ? .headline : .subheadline.weight(.semibold)).lineLimit(1)
            if let q = state.question {
                Text(q).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct VoiceButtons: View {
    var muted: Bool
    var body: some View {
        HStack(spacing: 8) {
            Button(intent: MuteVoiceIntent()) {
                Label(muted ? "Unmute" : "Mute", systemImage: muted ? "mic.fill" : "mic.slash.fill").frame(maxWidth: .infinity)
            }
            .tint(.gray)
            Button(intent: EndVoiceIntent()) {
                Label("End", systemImage: "xmark").frame(maxWidth: .infinity)
            }
            .tint(.red)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .font(.subheadline.weight(.semibold))
    }
}

struct VoiceLockScreen: View {
    var state: VoiceActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VoiceDot(state: state, size: 22).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                    VoiceText(state: state, prominent: true)
                }
                VoiceTimer(state: state).font(.subheadline).foregroundStyle(.secondary)
            }
            VoiceButtons(muted: state.muted)
        }
        .padding(16)
    }
}
