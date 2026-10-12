package dev.pi_mobile.app.voiceui

import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * The orb (`Orb` in `web/voice.js`, OrbView.swift): a blob in the state's colours that swells with the
 * voice that matters (yours while listening, pi's while speaking), breathes while pi works and rings while
 * pi waits on you. Decorative: hidden from TalkBack; the state label beside it is the accessible truth.
 *
 * Frames run only while something moves: not with reduced motion ([still], a still disc that scales a
 * little with the level), not once a grey state has settled, not while the app is in the background.
 * [level] is read while drawing, so a level change redraws without recomposing.
 */
@Composable
fun Orb(state: VoiceState, level: () -> Float, holding: Boolean, still: Boolean, modifier: Modifier = Modifier) {
    val model = remember { OrbModel() }
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    var settled by remember { mutableStateOf(false) }
    LaunchedEffect(state, holding) {
        settled = false
        if (!VoicePalette.isDim(state) || holding) return@LaunchedEffect
        delay(1500)
        settled = true
    }
    var frameNanos by remember { mutableLongStateOf(0L) }
    val running = !still && !settled && lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    LaunchedEffect(running) {
        // An infinite animation: tests and the system's animation policy treat it as such, not as pending work.
        while (running) withInfiniteAnimationFrameNanos { frameNanos = it }
    }
    Canvas(modifier.clearAndSetSemantics {}) {
        model.draw(this, frameNanos / 1e9, state, level(), holding, still)
    }
}

/** Per-frame smoothing (level, press, colours) kept across frames, as the web orb does. */
private class OrbModel {
    private var level = 0f
    private var press = 0f
    private var colors: Pair<Color, Color>? = null
    private var lastT = 0.0

    fun draw(g: DrawScope, t: Double, state: VoiceState, raw: Float, holding: Boolean, still: Boolean) = with(g) {
        val w = size.width
        val h = size.height
        if (w <= 0f || h <= 0f) return@with
        // Frame-rate independent easing: the web's per-frame factors are tuned for 60 Hz.
        val dt = if (lastT == 0.0) 1.0 / 60 else (t - lastT).coerceIn(0.0, 0.1)
        lastT = t
        fun ease(k: Double): Float = if (still) 1f else (1 - (1 - k).pow(dt * 60)).toFloat()
        val target = VoicePalette.pair(state)
        val current = colors ?: target
        val a = lerp(current.first, target.first, ease(0.06))
        val b = lerp(current.second, target.second, ease(0.06))
        colors = a to b
        level += (raw - level) * ease(if (raw > level) 0.35 else 0.08)
        press += ((if (holding) 1f else 0f) - press) * ease(0.25)

        val dim = VoicePalette.isDim(state)
        val breathe = when {
            still -> 0.0
            state == VoiceState.WORKING -> 0.06 * sin(t * 2.2)
            state == VoiceState.THINKING -> 0.04 * sin(t * 6)
            else -> 0.025 * sin(t * 1.3)
        }.toFloat()
        val c = Offset(w / 2, h / 2)
        // The base fits with room for the loudest swell, the press ring and the asking ring, so the orb
        // never reaches the label below its frame.
        val maxR = min(w, h) / 2
        val r0 = maxR / 1.75f
        val r = min(maxR / 1.2f, r0 * (1 + breathe + level * (if (still) 0.15f else 0.5f) + press * 0.1f))

        // Glow, faded out inside the frame so its edge never shows.
        val gr = min(r * 2.1f, maxR)
        val glow = a.copy(alpha = if (dim) 0.12f else 0.32f)
        drawCircle(
            Brush.radialGradient(0f to glow, r * 0.6f / gr to glow, 1f to a.copy(alpha = 0f), center = c, radius = gr),
            radius = gr, center = c,
        )

        // Body: a gently wobbling blob, more alive the louder the voice.
        val wobble = if (still) 0f else 0.035f + level * 0.12f
        val blob = Path()
        val n = 96
        for (i in 0..n) {
            val ang = i.toDouble() / n * PI * 2
            val noise = sin(ang * 3 + t * 1.7) * 0.5 + sin(ang * 5 - t * 2.3) * 0.3 + sin(ang * 2 + t * 0.9) * 0.2
            val rr = r * (1 + wobble * noise.toFloat())
            val x = c.x + cos(ang).toFloat() * rr
            val y = c.y + sin(ang).toFloat() * rr
            if (i == 0) blob.moveTo(x, y) else blob.lineTo(x, y)
        }
        blob.close()
        val rot = if (still) 0.0 else t * 0.4
        val dir = Offset(cos(rot).toFloat() * r, sin(rot).toFloat() * r)
        drawPath(
            blob,
            Brush.linearGradient(
                listOf(a.copy(alpha = if (dim) 0.35f else 0.95f), b.copy(alpha = if (dim) 0.3f else 0.9f)),
                start = c + dir, end = c - dir,
            ),
        )
        // Highlight for depth.
        drawPath(
            blob,
            Brush.radialGradient(
                listOf(Color.White.copy(alpha = if (dim) 0.08f else 0.28f), Color.White.copy(alpha = 0f)),
                center = Offset(c.x - r * 0.35f, c.y - r * 0.4f), radius = r * 0.9f,
            ),
        )

        // Held for push to talk: the finger covers the middle, so the answer is a swell and a ring.
        if (press > 0.02f) {
            drawCircle(a.copy(alpha = 0.55f * press), radius = r * 1.18f, center = c, style = Stroke(width = 4.dp.toPx()))
        }
        // Waiting on you: a slow ring (a still ring with reduced motion).
        if (state == VoiceState.ASKING) {
            val p = if (still) 0.25f else ((t % 1.6) / 1.6).toFloat()
            val rr = min(maxR - 2, r * (1.1f + p * 0.6f))
            drawCircle(a.copy(alpha = 0.5f * (1 - p)), radius = rr, center = c, style = Stroke(width = 3.dp.toPx()))
        }
    }
}
