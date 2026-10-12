package dev.pi_mobile.app.voiceui

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.pi_mobile.app.R
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.activity.compose.LocalActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pi_mobile.app.voice.VoiceEngine
import dev.pi_mobile.app.voice.VoiceHost
import dev.pi_mobile.app.voice.VoiceSetting
import dev.pi_mobile.app.voice.VoiceUiState
import dev.pi_mobile.app.voice.VoiceQuestion as EngineQuestion

// The voice engine bound to the stateless voice screen: its state as a VoiceScreenModel, its intents as
// VoiceActions, and the route MainActivity shows over the web view while voice mode runs.

/** The engine's state as the screen's model (the two packages keep their own types: engine vs Compose). */
fun VoiceUiState.toScreenModel(): VoiceScreenModel = VoiceScreenModel(
    state = VoiceState.valueOf(state.name),
    label = label,
    hint = hint,
    stageAction = stageAction,
    engineKind = engineKind?.let { VoiceEngineKind.valueOf(it.name) },
    heard = VoiceCaption(heard.text, heard.live),
    said = VoiceCaption(said.text, said.live),
    note = note,
    question = question?.toScreen(),
    muted = muted,
    talking = talking,
    holding = holding,
    agent = agent,
    machineId = machineId,
    sessionName = sessionName,
    machineName = machineName,
    sessionLine = sessionLine,
    sessionStatus = sessionStatus,
    settings = VoiceSettings(
        attention = VoiceAttention.valueOf(settings.attention.name),
        turns = VoiceTurns.valueOf(settings.turns.name),
        persona = settings.persona,
        personas = settings.personas.map { VoicePersona(it.id, it.name, it.blurb) },
        basicReason = settings.basicReason,
    ),
    sessions = sessions.map { VoiceSessionItem(it.agent, it.machine, it.name, it.machineName, it.status, it.waiting) },
)

private fun EngineQuestion.toScreen() = VoiceQuestion(
    id = id, kind = kind, title = title, message = message, destructive = destructive,
    options = options.map { it.toScreen() },
    grace = grace?.let { VoiceQuestion.Grace(it.untilMs, (it.totalSeconds * 1000).toLong()) },
)

private fun EngineQuestion.Option.toScreen() = VoiceQuestion.Option(label, value, destructive, primary, ghost)
private fun VoiceQuestion.Option.toEngine() = EngineQuestion.Option(label, value, destructive, primary, ghost)

/**
 * The screen's intents on the engine. [revokeConsent] is the app's (forget the consent, drop any dictation
 * take); voice mode then ends here.
 */
class EngineVoiceActions(private val engine: VoiceEngine, private val revokeConsent: () -> Unit) : VoiceActions {
    override fun pressStart() = engine.pressStart()
    override fun pressEnd(held: Boolean) = engine.pressEnd(held)
    override fun tap() = engine.tap()
    override fun toggleMute() = engine.toggleMute()
    override fun end() = engine.stop()
    override suspend fun answer(option: VoiceQuestion.Option, questionId: String) = engine.answer(option.toEngine(), questionId)
    override fun cancelGrace() = engine.cancelGrace()
    override suspend fun doItNow() = engine.doItNow()
    override fun switchSession(agent: String, machine: String) = engine.switchSession(agent, machine)
    override suspend fun setPersona(id: String) = engine.setPersona(id)
    override fun playSample(id: String) = engine.playSample(id)
    override fun setAttention(attention: VoiceAttention) =
        engine.applySetting(if (attention == VoiceAttention.GLANCE) VoiceSetting.GLANCE else VoiceSetting.EYES_FREE)
    override fun setTurns(turns: VoiceTurns) =
        engine.applySetting(if (turns == VoiceTurns.TAP) VoiceSetting.PUSH_TO_TALK else VoiceSetting.OPEN_MIC)
    override fun revokeConsent() {
        revokeConsent.invoke()
        engine.stop()
    }
}

/**
 * Voice mode over the web view: shown while [host] runs an engine, nothing otherwise. A route in
 * MainActivity rather than an activity of its own, so the web view stays alive underneath and catches up
 * on close. While it shows, the activity may appear over the lock screen and wake it (voice started from
 * a locked phone) [verify on device]. Back and End end voice mode (VoiceScreen); [onClosed] follows once
 * it has (the shell then calls `PiNative.voiceClosed()`).
 */
@Composable
fun VoiceRoute(host: VoiceHost, revokeConsent: () -> Unit, onClosed: () -> Unit, modifier: Modifier = Modifier) {
    val engine by host.running.collectAsStateWithLifecycle()
    val closed by rememberUpdatedState(onClosed)
    val wasOpen = remember { mutableStateOf(false) }
    LaunchedEffect(engine) {
        if (engine != null) wasOpen.value = true else if (wasOpen.value) {
            wasOpen.value = false
            closed()
        }
    }
    val e = engine ?: return
    OverLockScreen()
    val ui by e.ui.collectAsStateWithLifecycle()
    val levels = e.levels.collectAsStateWithLifecycle()
    val locked = rememberKeyguardLocked()
    val activity = LocalActivity.current
    val unlock: (() -> Unit) -> Unit = remember(activity) { { then -> requestUnlock(activity, then) } }
    val actions = remember(e, locked) {
        EngineVoiceActions(e, revokeConsent).let { if (locked) LockedVoiceActions(it, unlock) else it }
    }
    AnnounceQuestion(ui.question?.id, ui.question?.title)
    VoiceScreen(
        model = ui.toScreenModel(),
        actions = actions,
        // The web view underneath never gets a touch while voice mode is up.
        modifier = modifier.pointerInput(Unit) {
            awaitPointerEventScope { while (true) awaitPointerEvent(PointerEventPass.Final).changes.forEach { it.consume() } }
        },
        // Read while the orb draws, so level changes redraw it without recomposing the screen.
        levels = { levels.value.let { VoiceLevels(it.mine.toFloat(), it.pi.toFloat()) } },
        locked = locked,
        unlock = unlock,
    )
}

/**
 * Voice mode over the lock screen: Mute and End work as they are (they are on the notification too); everything
 * that changes what pi does or where (answers, Do it now, the switcher, settings, the circle) asks to unlock
 * first. A spoken answer still works: the microphone is the same, locked or not.
 */
class LockedVoiceActions(private val base: VoiceActions, private val unlock: (then: () -> Unit) -> Unit) : VoiceActions {
    override fun pressStart() = false
    override fun pressEnd(held: Boolean) = base.pressEnd(held)
    override fun tap() = unlock(base::tap)
    override fun toggleMute() = base.toggleMute()
    override fun end() = base.end()
    /** Saying no (Cancel in the undo window) is always safe. */
    override fun cancelGrace() = base.cancelGrace()
    override suspend fun answer(option: VoiceQuestion.Option, questionId: String): Boolean = false.also { unlock {} }
    override suspend fun doItNow() = unlock {}
    override fun switchSession(agent: String, machine: String) = unlock { base.switchSession(agent, machine) }
    override suspend fun setPersona(id: String) = unlock {}
    override fun playSample(id: String) = unlock { base.playSample(id) }
    override fun setAttention(attention: VoiceAttention) = unlock { base.setAttention(attention) }
    override fun setTurns(turns: VoiceTurns) = unlock { base.setTurns(turns) }
    override fun revokeConsent() = unlock(base::revokeConsent)
}

/** Asks the system to dismiss the keyguard (the user unlocks), then runs [then]. */
private fun requestUnlock(activity: Activity?, then: () -> Unit) {
    val keyguard = activity?.getSystemService(KeyguardManager::class.java)
    if (activity == null || keyguard == null || !keyguard.isKeyguardLocked) return then()
    keyguard.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = then()
    })
}

/** Whether the phone is locked now: checked on every resume, screen on and off, and unlock. */
@Composable
private fun rememberKeyguardLocked(): Boolean {
    val context = LocalContext.current
    val keyguard = remember(context) { context.getSystemService(KeyguardManager::class.java) }
    var locked by remember { mutableStateOf(keyguard.isKeyguardLocked) }
    LifecycleResumeEffect(keyguard) {
        locked = keyguard.isKeyguardLocked
        onPauseOrDispose {}
    }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                locked = keyguard.isKeyguardLocked
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        onDispose { context.unregisterReceiver(receiver) }
    }
    return locked
}

/** TalkBack hears a new question without hunting for it ("pi asks: ‹title›", as VoiceOver does on iOS). */
@Composable
private fun AnnounceQuestion(id: String?, title: String?) {
    val view = LocalView.current
    val text = title?.let { stringResource(R.string.voice_pi_asks_title, it) }
    LaunchedEffect(id) {
        @Suppress("DEPRECATION") // a one-off announcement; the note under the captions is a live region instead
        if (id != null && text != null) view.announceForAccessibility(text)
    }
}

/** Lets the activity show over the lock screen and turn the screen on while voice mode is up. */
@Composable
private fun OverLockScreen() {
    val activity = LocalActivity.current ?: return
    DisposableEffect(activity) {
        if (Build.VERSION.SDK_INT >= 27) {
            activity.setShowWhenLocked(true)
            activity.setTurnScreenOn(true)
        }
        onDispose {
            if (Build.VERSION.SDK_INT >= 27) {
                activity.setShowWhenLocked(false)
                activity.setTurnScreenOn(false)
            }
        }
    }
}
