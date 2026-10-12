package dev.pi_mobile.app.core

import android.content.Context
import android.content.SharedPreferences

/**
 * App settings in plain SharedPreferences (nothing secret: keys live in [MachineStore]). Keys match the
 * iOS app's UserDefaults keys so the two ports stay easy to compare. A thin typed wrapper; the logic that
 * uses each value lives with its feature (consent, push, voice).
 */
class Prefs(private val sp: SharedPreferences) {
    constructor(context: Context) : this(context.getSharedPreferences(FILE, Context.MODE_PRIVATE))

    /** The session last on screen (bridge `focus`) or last talked to; "Start voice" picks it when no session needs you. */
    data class Focus(val agent: String, val machine: String, val name: String)

    // Voice preferences: the web UI owns these keys (BRIDGE.md `prefs`); native keeps a copy and writes it
    // back into localStorage at each document start.

    fun voice(key: String): String? = sp.getString(key, null)

    /** Ignores keys outside [VOICE_KEYS], so the page can't fill the file with arbitrary data. */
    fun setVoice(key: String, value: String?) {
        if (key !in VOICE_KEYS) return
        sp.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }

    /** Every voice preference that is set, for the setup script. */
    val voicePrefs: Map<String, String> get() = VOICE_KEYS.mapNotNull { k -> voice(k)?.let { k to it } }.toMap()

    var lastFocus: Focus?
        get() {
            val raw = sp.getString(LAST_FOCUS, null) ?: return null
            val v = try { parseJson(raw) } catch (_: Exception) { return null }
            val agent = v["agent"].string ?: return null
            return Focus(agent, v["machine"].string ?: "", v["name"].string ?: "")
        }
        set(f) = put(LAST_FOCUS, f?.let { obj("agent" to it.agent, "machine" to it.machine, "name" to it.name).encode() })

    /** The consent version the user agreed to (AIConsent compares it with its current version); null = never or revoked. */
    var aiConsent: Int?
        get() = if (sp.contains(AI_CONSENT)) sp.getInt(AI_CONSENT, 0) else null
        set(v) = sp.edit().apply { if (v == null) remove(AI_CONSENT) else putInt(AI_CONSENT, v) }.apply()

    /** The user turned notifications on in the app. */
    var notificationsOn: Boolean
        get() = sp.getBoolean(PUSH_ON, false)
        set(v) = sp.edit().putBoolean(PUSH_ON, v).apply()

    /** The current FCM token. */
    var pushToken: String?
        get() = sp.getString(PUSH_TOKEN, null)
        set(v) = put(PUSH_TOKEN, v)

    /** The relay's capability, valid only for the token it was issued for (a new token needs a new one). */
    var relayCap: String?
        get() = sp.getString(RELAY_CAP, null)?.takeIf { sp.getString(RELAY_CAP_TOKEN, null) == pushToken }
        set(v) = sp.edit().apply {
            if (v == null) remove(RELAY_CAP).remove(RELAY_CAP_TOKEN) else putString(RELAY_CAP, v).putString(RELAY_CAP_TOKEN, pushToken)
        }.apply()

    /** `entry id|device id|token` already sent: a new computer or a new token registers again. */
    var pushRegistered: Set<String>
        get() = sp.getStringSet(PUSH_REGISTERED, null)?.toSet() ?: emptySet()
        set(v) = sp.edit().putStringSet(PUSH_REGISTERED, v).apply()

    /** No automatic relay registration before this (epoch ms): 501 pauses hours, other failures minutes. */
    var relayPausedUntilMs: Long?
        get() = if (sp.contains(RELAY_PAUSED)) sp.getLong(RELAY_PAUSED, 0) else null
        set(v) = sp.edit().apply { if (v == null) remove(RELAY_PAUSED) else putLong(RELAY_PAUSED, v) }.apply()

    private fun put(key: String, value: String?) = sp.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()

    companion object {
        const val FILE = "pi-prefs"
        val VOICE_KEYS = listOf("pi-mobile-voice-persona", "pi-mobile-voice-attention", "pi-mobile-voice-turns", "pi-mobile-voice-uses", "pi-mobile-voice-intro")
        const val LAST_FOCUS = "pi-native-voice-last"
        const val AI_CONSENT = "pi-ai-consent"
        const val PUSH_ON = "pi-push-on"
        const val PUSH_TOKEN = "pi-push-token"
        const val RELAY_CAP = "pi-push-relay-cap"
        const val RELAY_CAP_TOKEN = "pi-push-relay-cap-token"
        const val PUSH_REGISTERED = "pi-push-registered"
        const val RELAY_PAUSED = "pi-push-relay-paused"
    }
}
