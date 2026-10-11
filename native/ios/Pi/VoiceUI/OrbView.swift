import SwiftUI

/// The orb (`Orb` in `web/voice.js`): a blob in the state's colours that swells with the voice that
/// matters (yours while listening, pi's while speaking), breathes while pi works and rings while pi
/// waits on you. Decorative: the state label beside it is the accessible truth.
struct OrbView: View {
    let state: VoiceState
    /// The level that drives it (0–1), already chosen for the state.
    let level: Double
    /// Push to talk: a finger is on the circle.
    let holding: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = OrbModel()

    var body: some View {
        // Runs at the display's rate (120 Hz on ProMotion); paused when still or in the background.
        TimelineView(.animation(paused: reduceMotion || scenePhase != .active)) { timeline in
            Canvas { g, size in
                model.draw(g, size: size, t: timeline.date.timeIntervalSinceReferenceDate,
                           state: state, level: level, holding: holding, still: reduceMotion)
            }
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}

/// Per-frame smoothing (level, press, colours) kept across frames, as the web orb does.
@MainActor final class OrbModel {
    private var level = 0.0
    private var press = 0.0
    private var colors: [SIMD3<Double>]?
    private var lastT = 0.0

    func draw(_ g: GraphicsContext, size: CGSize, t: Double, state: VoiceState, level raw: Double, holding: Bool, still: Bool) {
        let w = size.width, h = size.height
        guard w > 0, h > 0 else { return }
        // Frame-rate independent easing: the web's per-frame factors are tuned for 60 Hz.
        let dt = lastT == 0 ? 1 / 60 : min(0.1, max(0, t - lastT))
        lastT = t
        func ease(_ k: Double) -> Double { still ? 1 : 1 - pow(1 - k, dt * 60) }
        let (c1, c2) = VoicePalette.pair(state)
        let target = [rgb(c1), rgb(c2)]
        if colors == nil { colors = target }
        colors = zip(colors!, target).map { $0 + ($1 - $0) * ease(0.06) }
        level += (raw - level) * ease(raw > level ? 0.35 : 0.08)
        press += ((holding ? 1 : 0) - press) * ease(0.25)

        let a = colors![0], b = colors![1]
        let dim = VoicePalette.isDim(state)
        let breathe = still ? 0 : state == .working ? 0.06 * sin(t * 2.2) : state == .thinking ? 0.04 * sin(t * 6) : 0.025 * sin(t * 1.3)
        let c = CGPoint(x: w / 2, y: h / 2)
        // The base fits with room for the loudest swell, the press ring and the asking ring, so the
        // orb never reaches the label below its frame.
        let maxR = min(w, h) / 2
        let r0 = maxR / 1.75
        let r = min(maxR / 1.2, r0 * (1 + breathe + level * (still ? 0.15 : 0.5) + press * 0.1))

        // Glow, faded out inside the frame so its edge never shows.
        let gr = min(r * 2.1, maxR)
        g.fill(Path(ellipseIn: CGRect(x: c.x - gr, y: c.y - gr, width: gr * 2, height: gr * 2)), with: .radialGradient(
            Gradient(colors: [color(a, dim ? 0.12 : 0.32), color(a, 0)]), center: c, startRadius: r * 0.6, endRadius: gr))

        // Body: a gently wobbling blob, more alive the louder the voice.
        let wobble = still ? 0 : 0.035 + level * 0.12
        var blob = Path()
        let n = 96
        for i in 0...n {
            let ang = Double(i) / Double(n) * .pi * 2
            let noise = sin(ang * 3 + t * 1.7) * 0.5 + sin(ang * 5 - t * 2.3) * 0.3 + sin(ang * 2 + t * 0.9) * 0.2
            let rr = r * (1 + wobble * noise)
            let p = CGPoint(x: c.x + cos(ang) * rr, y: c.y + sin(ang) * rr)
            if i == 0 { blob.move(to: p) } else { blob.addLine(to: p) }
        }
        blob.closeSubpath()
        let rot = still ? 0 : t * 0.4
        g.fill(blob, with: .linearGradient(
            Gradient(colors: [color(a, dim ? 0.35 : 0.95), color(b, dim ? 0.3 : 0.9)]),
            startPoint: CGPoint(x: c.x + cos(rot) * r, y: c.y + sin(rot) * r),
            endPoint: CGPoint(x: c.x - cos(rot) * r, y: c.y - sin(rot) * r)))
        // Highlight for depth.
        let hc = CGPoint(x: c.x - r * 0.35, y: c.y - r * 0.4)
        g.fill(blob, with: .radialGradient(
            Gradient(colors: [.white.opacity(dim ? 0.08 : 0.28), .white.opacity(0)]), center: hc, startRadius: 0, endRadius: r * 0.9))

        // Held for push to talk: the finger covers the middle, so the answer is a swell and a ring.
        if press > 0.02 {
            g.stroke(Path(ellipseIn: CGRect(x: c.x - r * 1.18, y: c.y - r * 1.18, width: r * 2.36, height: r * 2.36)),
                     with: .color(color(a, 0.55 * press)), lineWidth: 4)
        }
        // Waiting on you: a slow ring (a still ring with reduced motion).
        if state == .asking {
            let p = still ? 0.25 : t.truncatingRemainder(dividingBy: 1.6) / 1.6
            let rr = min(maxR - 2, r * (1.1 + p * 0.6))
            g.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: rr * 2, height: rr * 2)),
                     with: .color(color(a, 0.5 * (1 - p))), lineWidth: 3)
        }
    }

    private func rgb(_ c: Color) -> SIMD3<Double> {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(c).getRed(&r, green: &g, blue: &b, alpha: &a)
        return SIMD3(Double(r), Double(g), Double(b))
    }

    private func color(_ v: SIMD3<Double>, _ opacity: Double) -> Color {
        Color(.sRGB, red: v.x, green: v.y, blue: v.z, opacity: opacity)
    }
}
