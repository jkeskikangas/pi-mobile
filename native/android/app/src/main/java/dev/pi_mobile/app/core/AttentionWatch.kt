package dev.pi_mobile.app.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Personal build: the phone decides what deserves a notification from one computer's event stream, so no push
 * relay (and no Firebase) is needed. It mirrors what `src/bridge.ts` sends as `attention`:
 *
 * - `<name> asks`: a `prompt` event (urgent; dismissed again by its `prompt_end`).
 * - `<name> needs you`: the session turned `waiting` without an answerable prompt (a terminal-only dialog; urgent).
 * - `<name> finished`: the session went back to `idle` after working for more than [finishedAfterMs].
 *
 * The first `info` of a session only records it, and [seed] replaces what is known after a resync, so a reconnect
 * never replays old news. Pure logic: one instance per computer, driven by the watch service.
 */
class AttentionWatch(private val finishedAfterMs: Long = FINISHED_AFTER_MS) {
    sealed interface Action {
        val agent: String
        /** Stable per notification, so a [Dismiss] finds the [Alert] it ends. */
        val key: String
    }

    data class Alert(
        override val agent: String,
        override val key: String,
        val title: String,
        val body: String,
        val urgent: Boolean,
    ) : Action

    data class Dismiss(override val agent: String, override val key: String) : Action

    private class Session(var name: String, var status: String, var startedAt: Long?) {
        val prompts = mutableSetOf<String>()
    }

    private val sessions = HashMap<String, Session>()
    /** Prompts already announced; a replayed `prompt` event must not alert twice. */
    private val announced = LinkedHashSet<String>()

    /** What the computer reports now (the `hub` RPC's `agents`): known from here on, nothing announced. */
    fun seed(infos: List<JsonElement>, now: Long) {
        sessions.clear()
        for (info in infos) {
            val id = info["agent"].string ?: continue
            val status = info["status"].string ?: IDLE
            sessions[id] = Session(name(info), status, if (status == IDLE) null else info["since"].long ?: now)
        }
    }

    fun onEvent(ev: HubEvent, now: Long): List<Action> {
        val id = ev.agent ?: ev.raw["info"]["agent"].string ?: return emptyList()
        return when (ev.type) {
            "info" -> info(id, ev.raw["info"], now)
            "prompt" -> prompt(id, ev.raw["prompt"])
            "prompt_end" -> {
                val pid = ev.raw["id"].string ?: return emptyList()
                sessions[id]?.prompts?.remove(pid)
                listOf(Dismiss(id, promptKey(pid)))
            }
            "gone" -> {
                sessions.remove(id)
                listOf(Dismiss(id, waitKey(id)))
            }
            else -> emptyList()
        }
    }

    private fun info(id: String, info: JsonElement?, now: Long): List<Action> {
        if (info !is JsonObject) return emptyList()
        val status = info["status"].string ?: IDLE
        val s = sessions[id]
        if (s == null) {
            sessions[id] = Session(name(info), status, if (status == IDLE) null else info["since"].long ?: now)
            return emptyList()
        }
        s.name = name(info)
        val prev = s.status
        s.status = status
        val out = mutableListOf<Action>()
        if (prev == WAITING && status != WAITING) out += Dismiss(id, waitKey(id))
        when (status) {
            WORKING -> s.startedAt = info["since"].long ?: s.startedAt ?: now
            WAITING -> {
                if (s.startedAt == null) s.startedAt = now
                if (prev != WAITING && s.prompts.isEmpty()) {
                    out += Alert(id, waitKey(id), title(s, "needs you"), "Input needed in the terminal", urgent = true)
                }
            }
            else -> {
                val started = s.startedAt
                s.startedAt = null
                s.prompts.clear()
                if (prev != IDLE && started != null && now - started > finishedAfterMs) {
                    val body = info["last"].string?.takeIf { it.isNotBlank() } ?: "pi is idle."
                    out += Alert(id, "finished:$id:$started", title(s, "finished"), body, urgent = false)
                }
            }
        }
        return out
    }

    private fun prompt(id: String, prompt: JsonElement?): List<Action> {
        val pid = prompt["id"].string ?: return emptyList()
        val s = sessions.getOrPut(id) { Session("pi", WAITING, null) }
        s.prompts += pid
        if (!announced.add(pid)) return emptyList()
        while (announced.size > MAX_ANNOUNCED) announced.remove(announced.first())
        val body = prompt["title"].string?.takeIf { it.isNotBlank() } ?: "pi is waiting for your answer"
        return listOf(Alert(id, promptKey(pid), title(s, "asks"), body, urgent = true))
    }

    companion object {
        const val FINISHED_AFTER_MS = 20_000L
        private const val MAX_ANNOUNCED = 256
        private const val IDLE = "idle"
        private const val WORKING = "working"
        private const val WAITING = "waiting"

        fun promptKey(pid: String) = "prompt:$pid"
        fun waitKey(agent: String) = "wait:$agent"

        private fun name(info: JsonElement) = info["name"].string?.takeIf { it.isNotBlank() } ?: "pi"

        /** As `bridge.ts` attention: the session's name, cut at 40 characters, then the event. */
        private fun title(s: Session, event: String): String {
            val short = if (s.name.length > 40) s.name.take(39) + "…" else s.name
            return "$short $event"
        }
    }
}
