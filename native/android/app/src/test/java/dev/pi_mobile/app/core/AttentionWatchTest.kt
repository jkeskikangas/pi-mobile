package dev.pi_mobile.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionWatchTest {
    private fun info(agent: String, status: String, since: Long? = null, last: String? = null, name: String = "fix tests") =
        HubEvent(obj("type" to "info", "agent" to agent, "info" to obj("agent" to agent, "name" to name, "status" to status, "since" to since, "last" to last)))

    private fun prompt(agent: String, id: String, title: String) =
        HubEvent(obj("type" to "prompt", "agent" to agent, "prompt" to obj("id" to id, "kind" to "confirm", "title" to title)))

    private fun promptEnd(agent: String, id: String) = HubEvent(obj("type" to "prompt_end", "agent" to agent, "id" to id, "by" to "remote"))

    @Test fun firstSightIsNotNews() {
        val w = AttentionWatch()
        assertTrue(w.onEvent(info("a", "waiting"), 0).isEmpty())
        assertTrue(w.onEvent(info("b", "idle"), 0).isEmpty())
    }

    @Test fun longRunFinishes() {
        val w = AttentionWatch()
        w.onEvent(info("a", "idle"), 0)
        w.onEvent(info("a", "working", since = 1_000), 1_000)
        val out = w.onEvent(info("a", "idle", last = "All green."), 30_000)
        assertEquals(listOf(AttentionWatch.Alert("a", "finished:a:1000", "fix tests finished", "All green.", urgent = false)), out)
    }

    @Test fun shortRunIsQuiet() {
        val w = AttentionWatch()
        w.onEvent(info("a", "idle"), 0)
        w.onEvent(info("a", "working", since = 1_000), 1_000)
        assertTrue(w.onEvent(info("a", "idle"), 5_000).isEmpty())
    }

    @Test fun promptAsksOnceAndEndDismisses() {
        val w = AttentionWatch()
        w.onEvent(info("a", "working", since = 0), 0)
        val asked = w.onEvent(prompt("a", "p1", "Delete the branch?"), 1)
        assertEquals(listOf(AttentionWatch.Alert("a", "prompt:p1", "fix tests asks", "Delete the branch?", urgent = true)), asked)
        // The info that follows the prompt (waiting) is not a second alert, and a replayed prompt neither.
        assertTrue(w.onEvent(info("a", "waiting"), 2).isEmpty())
        assertTrue(w.onEvent(prompt("a", "p1", "Delete the branch?"), 3).isEmpty())
        assertEquals(listOf(AttentionWatch.Dismiss("a", "prompt:p1")), w.onEvent(promptEnd("a", "p1"), 4))
    }

    @Test fun terminalWaitNeedsYouAndClears() {
        val w = AttentionWatch()
        w.onEvent(info("a", "working", since = 0), 0)
        val out = w.onEvent(info("a", "waiting"), 1)
        assertEquals(listOf(AttentionWatch.Alert("a", "wait:a", "fix tests needs you", "Input needed in the terminal", urgent = true)), out)
        assertEquals(listOf(AttentionWatch.Dismiss("a", "wait:a")), w.onEvent(info("a", "working", since = 0), 2))
    }

    @Test fun seedReplacesKnowledge() {
        val w = AttentionWatch()
        w.seed(listOf(obj("agent" to "a", "name" to "x", "status" to "working", "since" to 0)), 0)
        val out = w.onEvent(info("a", "idle", name = "x"), 60_000)
        assertEquals("x finished", (out.single() as AttentionWatch.Alert).title)
    }

    @Test fun longNamesAreCut() {
        val w = AttentionWatch()
        val name = "n".repeat(50)
        w.onEvent(info("a", "working", since = 0, name = name), 0)
        val t = (w.onEvent(prompt("a", "p", "q"), 1).single() as AttentionWatch.Alert).title
        assertEquals("n".repeat(39) + "… asks", t)
    }
}
