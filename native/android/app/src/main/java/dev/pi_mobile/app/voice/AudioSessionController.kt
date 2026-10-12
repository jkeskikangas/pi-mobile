package dev.pi_mobile.app.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import dev.pi_mobile.app.core.Prefs

/**
 * The audio session (plans D5, D8, A9): communication mode, the route (headset first, never the earpiece),
 * audio focus as interruptions, input mute, the headset button and network changes.
 * Port of native/ios/Pi/Voice/AudioSessionController.swift. Callbacks arrive on the main thread.
 */
class AudioSessionController(context: Context) : VoiceAudioSession {
    override var onInterruption: ((began: Boolean?) -> Unit)? = null
    override var onRouteChange: ((String) -> Unit)? = null
    override var onInputMute: ((Boolean) -> Unit)? = null
    override var onRemoteToggle: (() -> Unit)? = null
    override var onNetworkChange: (() -> Unit)? = null

    private val app = context.applicationContext
    private val audio = app.getSystemService(AudioManager::class.java)
    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var active = false
    private var previousMode = AudioManager.MODE_NORMAL
    private var focus: AudioFocusRequest? = null
    /** Focus was lost for a while (a call, the assistant): regaining it resumes. */
    private var lostTransiently = false
    private var media: MediaSession? = null
    /** The kind of network in use (Wi-Fi, mobile…), as iOS's path monitor keys it. */
    private var lastNetworkKind: String? = null

    override val route: String
        get() = if (Build.VERSION.SDK_INT >= 31) audio.communicationDevice?.let(::nameOf) ?: "" else legacyRoute()

    /** Takes focus and communication mode; throws with a sentence while another app holds the audio (a call). */
    override fun activate() {
        val request = focus ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(VOICE)
            .setOnAudioFocusChangeListener(::focusChanged, main)
            .build()
        if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            throw IllegalStateException("Another app is using the audio.")
        }
        focus = request
        lostTransiently = false
        // Every activate (also resuming after a call, which may have changed both), like iOS's setConfiguration.
        if (!active) previousMode = audio.mode
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        routeAudio()
        if (active) return
        audio.registerAudioDeviceCallback(devices, main)
        if (Build.VERSION.SDK_INT >= 28) {
            ContextCompat.registerReceiver(app, muteReceiver, IntentFilter(AudioManager.ACTION_MICROPHONE_MUTE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        }
        connectivity.registerDefaultNetworkCallback(network, main)
        enableRemote()
        active = true
    }

    override fun deactivate() {
        if (!active) return
        active = false
        audio.unregisterAudioDeviceCallback(devices)
        if (Build.VERSION.SDK_INT >= 28) app.unregisterReceiver(muteReceiver)
        connectivity.unregisterNetworkCallback(network)
        lastNetworkKind = null
        disableRemote()
        clearStaleMute(app)
        if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else {
            @Suppress("DEPRECATION")
            if (audio.isBluetoothScoOn) {
                audio.stopBluetoothSco()
                audio.isBluetoothScoOn = false
            }
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = false
        }
        audio.mode = previousMode
        focus?.let(audio::abandonAudioFocusRequest)
        focus = null
    }

    override val isInputMuted: Boolean get() = audio.isMicrophoneMute

    /**
     * The mute is the phone's, not pi's (every app's microphone): pi notes that it set it, so the mute is lifted
     * when voice mode ends, and at the next start after a crash ([clearStaleMute]).
     */
    override fun setInputMuted(muted: Boolean) {
        audio.isMicrophoneMute = muted
        app.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE).edit { putBoolean(MUTED_BY_PI, muted) }
    }

    // Focus: the Android counterpart of AVAudioSession interruptions.

    private fun focusChanged(change: Int) {
        if (!active) return
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                lostTransiently = true
                onInterruption?.invoke(true)
            }
            // Gone for good (another app took the audio): pause; resuming takes a tap.
            AudioManager.AUDIOFOCUS_LOSS -> {
                lostTransiently = false
                focus = null
                onInterruption?.invoke(true)
            }
            AudioManager.AUDIOFOCUS_GAIN -> if (lostTransiently) {
                lostTransiently = false
                onInterruption?.invoke(false)
            }
            // A short sound over us (a navigation prompt) is fine: voice goes on.
        }
    }

    // Routes

    /** The best output for a voice call: a headset if there is one, else the speaker (never the earpiece). */
    private fun routeAudio() {
        if (Build.VERSION.SDK_INT >= 31) {
            AudioRoutes.pick(audio.availableCommunicationDevices) { it.type }?.let(audio::setCommunicationDevice)
            return
        }
        // Before Android 12: SCO for Bluetooth headsets, the speakerphone flag otherwise.
        val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        @Suppress("DEPRECATION")
        when (AudioRoutes.pick(outputs) { it.type }?.let { AudioRoutes.kind(it.type) }) {
            AudioRoutes.Kind.BLUETOOTH -> {
                audio.isSpeakerphoneOn = false
                audio.startBluetoothSco()
                audio.isBluetoothScoOn = true
            }
            AudioRoutes.Kind.WIRED -> {
                audio.stopBluetoothSco()
                audio.isSpeakerphoneOn = false
            }
            else -> {
                audio.stopBluetoothSco()
                audio.isSpeakerphoneOn = true
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyRoute(): String {
        val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        val wanted = when {
            audio.isBluetoothScoOn -> AudioRoutes.Kind.BLUETOOTH
            audio.isSpeakerphoneOn -> AudioRoutes.Kind.SPEAKER
            else -> AudioRoutes.Kind.WIRED
        }
        return outputs.firstOrNull { AudioRoutes.kind(it.type) == wanted }?.let(::nameOf) ?: ""
    }

    private fun nameOf(d: AudioDeviceInfo) = AudioRoutes.name(d.type, d.productName?.toString())

    /** A headset came or went: re-pick; losing one falls back to the speaker and voice mode goes on. */
    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = changed()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = changed()
        private fun changed() {
            if (!active) return
            routeAudio()
            onRouteChange?.invoke(route)
        }
    }

    // Input mute (system-wide on Android, like the iOS app-wide input mute)

    private val muteReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            onInputMute?.invoke(audio.isMicrophoneMute)
        }
    }

    // Headset button (web: mediaSession play/pause)

    /** A media session that claims to play, so the headset button reaches it. [verify] during communication mode. */
    private fun enableRemote() {
        if (media != null) return
        media = MediaSession(app, "pi voice").apply {
            setCallback(
                object : MediaSession.Callback() {
                    override fun onPlay() = toggle()
                    override fun onPause() = toggle()
                    private fun toggle() {
                        onRemoteToggle?.invoke()
                    }
                },
                main,
            )
            setPlaybackState(
                PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE)
                    .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                    .build(),
            )
            isActive = true
        }
    }

    private fun disableRemote() {
        media?.release()
        media = null
    }

    // Network

    /** After the first network, a different default network (Wi-Fi ↔ mobile) → [onNetworkChange]. */
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(n: Network, caps: NetworkCapabilities) {
            if (!active) return
            val kind = NetworkKinds.kind(caps::hasTransport)
            val last = lastNetworkKind
            lastNetworkKind = kind
            if (NetworkKinds.changed(last, kind)) onNetworkChange?.invoke()
        }
    }

    companion object {
        private const val MUTED_BY_PI = "pi-voice-muted-mic"

        /** Lifts the phone-wide microphone mute if pi set it and voice mode is gone (ended, crashed, killed). */
        fun clearStaleMute(context: Context) {
            val sp = context.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
            if (!sp.getBoolean(MUTED_BY_PI, false)) return
            context.getSystemService(AudioManager::class.java).isMicrophoneMute = false
            sp.edit { putBoolean(MUTED_BY_PI, false) }
        }

        val VOICE: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
    }
}

/**
 * Which network change counts (unit tested): only a different kind (Wi-Fi ↔ mobile), like iOS's path monitor;
 * another Wi-Fi, or the same one coming back with new capabilities, doesn't redial the call.
 */
object NetworkKinds {
    fun kind(hasTransport: (Int) -> Boolean): String = when {
        hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
    }

    /** After the first network, a different kind. */
    fun changed(last: String?, now: String): Boolean = last != null && last != now
}

/** Which output a voice call uses, as pure functions of `AudioDeviceInfo` types (unit tested). */
object AudioRoutes {
    enum class Kind { BLUETOOTH, WIRED, SPEAKER, EARPIECE, OTHER }

    fun kind(type: Int): Kind = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_HEARING_AID -> Kind.BLUETOOTH
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> Kind.WIRED
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> Kind.SPEAKER
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> Kind.EARPIECE
        else -> Kind.OTHER
    }

    /** A Bluetooth headset, else a wired one, else the speaker; null if none of those is there. */
    fun <T> pick(devices: List<T>, type: (T) -> Int): T? =
        devices.filter { kind(type(it)) in PREFERENCE }.minByOrNull { PREFERENCE.indexOf(kind(type(it))) }

    /** "Speaker" for the phone's own, else the device's product name ("Pixel Buds"). */
    fun name(type: Int, product: String?): String = when (kind(type)) {
        Kind.SPEAKER -> "Speaker"
        Kind.EARPIECE -> "Phone"
        else -> product?.takeIf { it.isNotBlank() } ?: if (kind(type) == Kind.BLUETOOTH) "Bluetooth" else "Headset"
    }

    private val PREFERENCE = listOf(Kind.BLUETOOTH, Kind.WIRED, Kind.SPEAKER)
}
