package dev.pi_mobile.app.app

import dev.pi_mobile.app.shell.BridgeError
import dev.pi_mobile.app.shell.PermissionResult
import dev.pi_mobile.app.shell.VoiceStarter
import dev.pi_mobile.app.voice.VoiceHost

/**
 * The one way into voice mode (bridge, notifications, tile, shortcut, Talk to pi): the user's OK first (the sheet
 * explains what the permission is for), then the microphone, then voice/VoiceHost. A microphone only Settings can
 * turn back on is [blocked]: the app offers to open them, as for dictation.
 */
class AppVoice(
    private val consent: suspend () -> Unit,
    private val microphone: suspend () -> PermissionResult,
    private val blocked: () -> Unit,
    private val open: suspend (agent: String?, machine: String?) -> Unit,
    private val end: () -> Unit,
) : VoiceStarter {
    override suspend fun start(agent: String?, machine: String?) {
        consent()
        when (microphone()) {
            PermissionResult.GRANTED -> Unit
            PermissionResult.DENIED -> throw BridgeError(VoiceHost.MIC_OFF)
            PermissionResult.BLOCKED -> {
                blocked()
                throw BridgeError(VoiceHost.MIC_OFF)
            }
        }
        open(agent, machine?.ifEmpty { null })
    }

    override fun stop() = end()
}

/** Dialogs that send the user to Settings when only Settings can turn a permission back on; MainActivity shows them. */
interface SettingsOffer {
    fun microphone(forVoice: Boolean)
    fun notifications()
}
