package dev.pi_mobile.app.consent

import android.content.SharedPreferences
import androidx.annotation.MainThread
import androidx.core.content.edit
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The user's OK to send their voice to third parties (Google Play's User Data policy, App Review 5.1.2(i)
 * on iOS): asked once, before the first voice mode or dictation, with a native sheet that names who gets
 * what ([ConsentSheet]). Stored as the version of the recipients the user agreed to; bump [VERSION]
 * whenever that list changes and everyone is asked again. Revoked from voice settings or the web menu
 * (BRIDGE.md `consent.*`). Port of native/ios/Pi/Consent/AIConsent.swift.
 *
 * @param ask shows the sheet and returns the choice ([ConsentPrompter.ask] in the app; a fake in tests).
 * @param canAsk whether a sheet can be shown now (the activity is in front); false for starts from the
 *   Quick Settings tile or a notification while the app isn't visible.
 */
@MainThread
class AIConsent(
    private val prefs: SharedPreferences,
    private val ask: suspend (Purpose) -> Boolean,
    private val canAsk: () -> Boolean,
) {
    enum class Purpose { VOICE, DICTATION }

    /**
     * Not now. The message goes to the web as the `voice.start` / `dictation.start` error, word for word
     * as BRIDGE.md documents it, so it is a constant rather than a translatable resource.
     */
    class Declined(val purpose: Purpose) : Exception(
        if (purpose == Purpose.VOICE) "Voice mode needs your OK to send your voice. Try again to see the details."
        else "Dictation needs your OK to send audio to your computer. Try again to see the details.",
    )

    /** The app isn't on screen: the question can't be asked there. */
    class NeedsApp : Exception("Open pi to allow voice mode first.")

    private var asking: CompletableDeferred<Boolean>? = null

    val granted: Boolean get() = prefs.getInt(KEY, 0) == VERSION

    fun grant() = prefs.edit { putInt(KEY, VERSION) }

    fun revoke() = prefs.edit { remove(KEY) }

    /**
     * Returns once the user has agreed; throws [Declined] (Not now) or [NeedsApp] (not in front).
     * Concurrent callers (voice and dictation racing) share one sheet and its answer.
     */
    suspend fun ensure(purpose: Purpose) {
        if (granted) return
        if (!canAsk()) throw NeedsApp()
        val shared = asking
        val ok = if (shared != null) {
            shared.await()
        } else {
            val mine = CompletableDeferred<Boolean>().also { asking = it }
            try {
                ask(purpose).also { mine.complete(it) }
            } catch (e: Throwable) {
                // The asker went away (cancelled): nobody answered, so nobody may go ahead.
                mine.complete(false)
                throw e
            } finally {
                asking = null
            }
        }
        if (ok) grant() else throw Declined(purpose)
    }

    companion object {
        /** 1: voice → OpenAI (realtime) + your computer; dictation → your computer → its transcription provider.
         *  2: also session context to the realtime model, basic voice's speech services, dictation's AI tidy-up. */
        const val VERSION = 2
        const val KEY = "pi-ai-consent"
    }
}

/**
 * Shows [ConsentSheet] from anywhere (the bridge, the voice host, dictation) and suspends until the user
 * chooses: the app's [AIConsent.ask]. [ConsentHost] at the root of the UI draws the sheet while [pending].
 */
@Stable
class ConsentPrompter {
    /** The question on screen, if any. */
    class Request(val purpose: AIConsent.Purpose, val choose: (Boolean) -> Unit)

    var pending: Request? by mutableStateOf(null)
        private set

    suspend fun ask(purpose: AIConsent.Purpose): Boolean = suspendCancellableCoroutine { cont ->
        val request = Request(purpose) { ok ->
            pending = null
            if (cont.isActive) cont.resume(ok)
        }
        pending = request
        cont.invokeOnCancellation { if (pending === request) pending = null }
    }
}
