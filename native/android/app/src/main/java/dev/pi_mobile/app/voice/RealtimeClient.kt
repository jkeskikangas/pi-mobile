package dev.pi_mobile.app.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaRecorder
import dev.pi_mobile.app.core.encode
import dev.pi_mobile.app.core.parseJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class RealtimeException(message: String) : Exception(message)

/**
 * The OpenAI realtime call over WebRTC (plan D4, A9): mic track + `oai-events` data channel.
 * Port of native/ios/Pi/Voice/RealtimeClient.swift on io.getstream:stream-webrtc-android.
 *
 * WebRTC calls back on its own threads; everything is handed to [scope] (the engine's main dispatcher)
 * before it touches state or reaches the engine.
 */
class RealtimeClient(context: Context, private val scope: CoroutineScope) : RealtimeTransport {
    override var onEvent: ((JsonElement) -> Unit)? = null
    override var onLost: (() -> Unit)? = null

    override var micEnabled: Boolean = true
        set(v) {
            field = v
            localTrack?.setEnabled(v)
        }

    /** 1 normal, 0.2 ducked. `AudioTrack.setVolume` is a gain in [0, 10] with 1 = unity. [verify] loudness on device. */
    override var remoteVolume: Double = 1.0
        set(v) {
            field = v
            applyRemoteVolume()
        }

    override val micLevel: Double get() = levels.mic
    override val piLevel: Double get() = levels.pi
    override val micRaw: Double get() = levels.micRaw

    private val factory = factory(context.applicationContext)
    private var pc: PeerConnection? = null
    private var channel: DataChannel? = null
    private var source: AudioSource? = null
    private var localTrack: AudioTrack? = null
    private var remoteTrack: AudioTrack? = null
    private var channelOpen = false
    private var connected = false
    private var closed = false
    private var opened: CompletableDeferred<Unit>? = null
    private var statsJob: Job? = null
    private var disconnectJob: Job? = null
    private val levels = Levels()

    override suspend fun connect(exchange: suspend (offerSdp: String) -> String) {
        val config = PeerConnection.RTCConfiguration(emptyList()).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val pc = factory.createPeerConnection(config, Observer()) ?: throw notConnected()
        this.pc = pc

        // Mic. Echo cancellation and noise suppression: the device's (JavaAudioDeviceModule) and WebRTC's own. [verify]
        val mic = factory.createAudioSource(MediaConstraints())
        source = mic
        val track = factory.createAudioTrack("mic", mic)
        track.setEnabled(micEnabled)
        localTrack = track
        pc.addTrack(track, listOf("pi"))

        val dc = pc.createDataChannel("oai-events", DataChannel.Init().apply { ordered = true }) ?: throw notConnected()
        dc.registerObserver(ChannelObserver(dc))
        channel = dc
        opened = CompletableDeferred()

        val offer = sdp<SessionDescription> { pc.createOffer(it, MediaConstraints()) }
        sdp<Unit> { pc.setLocalDescription(it, offer) }
        val answer = exchange(offer.description)
        if (closed) throw notConnected()
        sdp<Unit> { pc.setRemoteDescription(it, SessionDescription(SessionDescription.Type.ANSWER, answer)) }
        withTimeoutOrNull(15_000) { opened?.await() } ?: throw notConnected()
        startStats()
    }

    override fun send(event: JsonElement) {
        val c = channel ?: return
        if (!channelOpen) return
        c.send(DataChannel.Buffer(ByteBuffer.wrap(event.encode().toByteArray()), false))
    }

    override fun close() {
        if (closed) return
        closed = true
        statsJob?.cancel()
        disconnectJob?.cancel()
        opened?.completeExceptionally(notConnected())
        channel?.unregisterObserver()
        channel?.close()
        localTrack?.setEnabled(false)
        pc?.dispose() // closes and frees the connection, its senders' tracks and the channel
        source?.dispose()
        source = null
        channel = null
        pc = null
        localTrack = null
        remoteTrack = null
        channelOpen = false
        levels.reset()
    }

    // Offer/answer

    /** Runs one SDP operation; [T] is the created description, or Unit for a set. */
    @Suppress("UNCHECKED_CAST")
    private suspend fun <T> sdp(op: (SdpObserver) -> Unit): T = suspendCancellableCoroutine { cont ->
        op(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) = cont.resume(d as T)
            override fun onSetSuccess() = cont.resume(Unit as T)
            override fun onCreateFailure(error: String?) = cont.resumeWithException(RealtimeException(error ?: NOT_CONNECTED))
            override fun onSetFailure(error: String?) = cont.resumeWithException(RealtimeException(error ?: NOT_CONNECTED))
        })
    }

    private fun notConnected() = RealtimeException(NOT_CONNECTED)

    // Events, on the engine's thread

    private fun channelStateChanged(state: DataChannel.State) {
        if (closed) return
        when (state) {
            DataChannel.State.OPEN -> {
                channelOpen = true
                opened?.complete(Unit)
            }
            DataChannel.State.CLOSING, DataChannel.State.CLOSED -> {
                // The events channel is the call's control: without it the call is lost.
                val was = channelOpen
                channelOpen = false
                if (was) onLost?.invoke()
            }
            else -> {}
        }
    }

    private fun received(text: String) {
        if (closed) return
        val json = try { parseJson(text) } catch (_: Exception) { return }
        onEvent?.invoke(json)
    }

    private fun connectionStateChanged(state: PeerConnection.PeerConnectionState) {
        if (closed) return
        if (state != PeerConnection.PeerConnectionState.DISCONNECTED) disconnectJob?.cancel()
        when (state) {
            PeerConnection.PeerConnectionState.CONNECTED -> connected = true
            PeerConnection.PeerConnectionState.FAILED, PeerConnection.PeerConnectionState.CLOSED -> lost()
            // A short network blip recovers by itself; a disconnect that lasts is a lost call. [verify] timing on device
            PeerConnection.PeerConnectionState.DISCONNECTED -> if (disconnectJob?.isActive != true) {
                disconnectJob = scope.launch {
                    delay(DISCONNECT_GRACE_MS)
                    if (pc?.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED) lost()
                }
            }
            else -> {}
        }
    }

    private fun lost() {
        if (!connected || closed) return
        connected = false
        onLost?.invoke()
    }

    private fun remoteTrackAdded(track: AudioTrack) {
        if (closed) return
        remoteTrack = track
        applyRemoteVolume()
    }

    private fun applyRemoteVolume() {
        remoteTrack?.setVolume(remoteVolume.coerceIn(0.0, 10.0))
    }

    // Levels

    private fun startStats() {
        statsJob?.cancel()
        statsJob = scope.launch {
            while (isActive) {
                delay(100)
                val pc = pc ?: return@launch
                val (mic, pi) = audioLevels(pc)
                if (closed) return@launch
                levels.update(mic, pi)
            }
        }
    }

    /**
     * `media-source` (kind audio) audioLevel = mic, `inbound-rtp` (kind audio) audioLevel = pi.
     * [verify] that media-source carries audioLevel for the mic on Android.
     */
    private suspend fun audioLevels(pc: PeerConnection): Pair<Double?, Double?> = suspendCancellableCoroutine { cont ->
        pc.getStats { report ->
            var mic: Double? = null
            var pi: Double? = null
            for (stat in report.statsMap.values) {
                val m = stat.members
                val kind = (m["kind"] ?: m["mediaType"]) as? String
                val level = (m["audioLevel"] as? Number)?.toDouble() ?: continue
                if (kind != null && kind != "audio") continue
                if (stat.type == "media-source") mic = level else if (stat.type == "inbound-rtp") pi = level
            }
            cont.resume(mic to pi)
        }
    }

    // WebRTC threads → the engine's thread

    private fun hop(f: () -> Unit) {
        scope.launch { f() }
    }

    private inner class Observer : PeerConnection.Observer {
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) = hop { connectionStateChanged(newState) }
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>?) {
            val track = receiver.track() as? AudioTrack ?: return
            hop { remoteTrackAdded(track) }
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidate(candidate: IceCandidate?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(dc: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
    }

    private inner class ChannelObserver(private val dc: DataChannel) : DataChannel.Observer {
        override fun onStateChange() {
            val state = dc.state()
            hop { channelStateChanged(state) }
        }
        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
            val text = String(bytes, Charsets.UTF_8)
            hop { received(text) }
        }
        override fun onBufferedAmountChange(previousAmount: Long) {}
    }

    companion object {
        private const val NOT_CONNECTED = "realtime voice did not connect"
        private const val DISCONNECT_GRACE_MS = 10_000L
        @Volatile private var shared: PeerConnectionFactory? = null

        /**
         * One factory for the process: the device's echo canceller and noise suppressor on, the mic opened as
         * a voice-communication source and pi played as voice communication (plan A9), so the platform AEC
         * hears what it has to cancel.
         */
        @Synchronized
        private fun factory(app: Context): PeerConnectionFactory = shared ?: run {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
            val adm = JavaAudioDeviceModule.builder(app)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .createAudioDeviceModule()
            PeerConnectionFactory.builder().setAudioDeviceModule(adm).createPeerConnectionFactory().also { shared = it }
        }
    }
}
