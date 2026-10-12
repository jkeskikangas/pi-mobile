package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.HubInfo
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The app's [HubClient] as voice mode's [FleetClient]: the same calls, its updates in voice's own type. */
class HubFleetClient(private val hub: HubClient) : FleetClient {
    override suspend fun rpc(m: String, p: JsonObject): JsonElement = hub.rpc(m, p)
    override suspend fun agent(agent: String, m: String, p: JsonObject): JsonElement = hub.agent(agent, m, p)
    override suspend fun hub(): HubInfo = hub.hub()
    override suspend fun focus(agent: String) = hub.focus(agent)
    override fun updates(): Flow<FleetClient.Update> = hub.updates().map {
        when (it) {
            is HubClient.Update.State -> FleetClient.Update.State(it.state)
            is HubClient.Update.Event -> FleetClient.Update.Event(it.event)
        }
    }
}
