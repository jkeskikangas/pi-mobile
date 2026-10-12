package dev.pi_mobile.app.core

/**
 * The sealed push from the relay (`relay/src/fcm.ts`): a data-only FCM message `{ sealed, urgent? }`, where
 * `sealed` holds `{ title, body, agent, machine }` sealed to this phone's device key on the sending computer.
 * Google sees neither the text nor which session it is about. Pure logic; the push package posts it.
 * Port of native/ios/Pi/Core/PushContent.swift.
 */
object PushContent {
    /** Shown when nothing opens the payload (key missing, computer forgotten, garbled payload). */
    const val GENERIC_TITLE = "pi"
    const val GENERIC_BODY = "New activity"

    data class Opened(
        val title: String,
        val body: String,
        val agent: String,
        /** The sending computer's id (its hub's machine id). */
        val machine: String,
        /** This phone's machines-list entry whose key opened it (BRIDGE.md `voice.start` `machine`). */
        val entry: String,
    )

    /** What to post. [group] is `machine:agent` (per session) or null; [asks] offers "Answer by voice". */
    data class Shown(
        val title: String,
        val body: String,
        val opened: Opened?,
        val group: String?,
        val asks: Boolean,
    )

    /**
     * The payload does not say which computer sent it (Google would see that), so each stored key is tried:
     * secretbox authenticates, a wrong key never opens.
     */
    fun open(sealed: String, machines: List<Machine>): Opened? {
        for (m in machines) {
            val key = m.key ?: continue
            val v = Envelope.open(key, sealed)?.obj ?: continue
            val machine = v["machine"].string ?: m.machine
            // Prefer the entry that names this computer, if one has the same key.
            val entry = machines.firstOrNull { it.machine == machine && machine.isNotEmpty() && it.k == m.k }?.id ?: m.id
            return Opened(v["title"].string ?: "pi", v["body"].string ?: "", v["agent"].string ?: "", machine, entry)
        }
        return null
    }

    /** The notification for an FCM data map: the real title and body, or the generic text when nothing opens it. */
    fun shown(data: Map<String, String>, machines: List<Machine>): Shown {
        val o = data["sealed"]?.let { open(it, machines) } ?: return Shown(GENERIC_TITLE, GENERIC_BODY, null, null, false)
        val group = if (o.agent.isNotEmpty()) "${o.machine}:${o.agent}" else null
        return Shown(
            title = o.title.ifEmpty { GENERIC_TITLE },
            body = o.body.ifEmpty { GENERIC_BODY },
            opened = o,
            group = group,
            asks = data["urgent"] == "1" && o.agent.isNotEmpty(),
        )
    }
}
