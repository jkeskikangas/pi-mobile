package dev.pi_mobile.app.push

import kotlinx.serialization.json.JsonElement

/**
 * What the web's Notifications row asks of native code (BRIDGE.md `push.status`, `push.enable`). Lives here
 * rather than in the shell so the bridge depends on push, not the other way round; [dev.pi_mobile.app.PushCenter]
 * implements it.
 */
interface PushController {
    /** `{ on, permission, available, computers: [{ machine, notify, why? }] }`. */
    suspend fun status(): JsonElement

    /** The new [status]; throws with a sentence the web shows as is when notifications can't be turned on. */
    suspend fun enable(on: Boolean): JsonElement
}
