package dev.pi_mobile.app.shell

/*
 * What the bridge (NativeBridge, BRIDGE.md) needs from features built elsewhere (push's is push/PushController;
 * consent is consent/AIConsent itself). Each is implemented by its feature's
 * package and handed to NativeBridge in PiApplication; the bridge only translates messages and replies.
 *
 * Every suspend function reports a failure by throwing: the exception's message is the sentence the page shows
 * (BRIDGE.md: "write it as a sentence fragment"), so throw [BridgeError] or any exception with a user-facing message.
 */

/** A failure whose [message] the page shows as is. */
class BridgeError(message: String) : Exception(message)

/** Native voice mode (package `voice`; the iOS VoiceHost). */
interface VoiceStarter {
    /**
     * Presents voice mode on session [agent] of the computer whose machines-list entry id is [machine], and returns
     * once it is on screen (BRIDGE.md `voice.start`). Idempotent: when voice mode is already open it is focused and
     * switched to [agent]. The bridge has already discarded any dictation take, so the microphone is free. Asks for
     * the user's consent itself (AIConsent.ensure(VOICE)) and throws its sentence when it isn't given.
     */
    suspend fun start(agent: String, machine: String)

    /** Ends voice mode if it is open (the user took back their consent); no-op otherwise. */
    fun stop()
}

/** The pairing-code scanner over the web view (BRIDGE.md `scan`); implemented by [ScanCenter]. */
interface Scanner {
    /**
     * The scanned pairing link. Throws [BridgeError] with exactly `cancelled` when the user closed the scanner,
     * `busy` when a scan is already open, or a sentence (no camera, camera access off).
     */
    suspend fun scan(): String
}
