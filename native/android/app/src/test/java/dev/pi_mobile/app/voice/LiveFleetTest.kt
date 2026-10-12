package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.EmptyObject
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.HubEvent
import dev.pi_mobile.app.core.HubInfo
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.obj
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** LiveFleet over fake clients: one stream per machine, merged and tagged; credentials decide reconnects. */
@OptIn(ExperimentalCoroutinesApi::class)
class LiveFleetTest {
    private class FakeClient(val machine: Machine) : FleetClient {
        val stream = Channel<FleetClient.Update>(Channel.UNLIMITED)
        val agentCalls = mutableListOf<String>()
        override suspend fun rpc(m: String, p: JsonObject): JsonElement = obj("m" to m)
        override suspend fun agent(agent: String, m: String, p: JsonObject): JsonElement = obj("agent" to agent).also { agentCalls.add(m) }
        override suspend fun hub(): HubInfo = HubInfo(EmptyObject)
        override suspend fun focus(agent: String) {}
        override fun updates(): Flow<FleetClient.Update> = stream.receiveAsFlow()
    }

    private fun machine(id: String, d: String = "d") = Machine(id = id, name = "n-$id", origin = "https://$id", d = d, k = "k")

    @Test fun mergesEveryMachinesUpdatesAndReportsRemoval() = runTest {
        val clients = mutableMapOf<String, FakeClient>()
        val fleet = LiveFleet(listOf(machine("m1"), machine("m2")), backgroundScope) { m -> FakeClient(m).also { clients[m.id] = it } }
        val removed = mutableListOf<String>()
        fleet.onUnauthorized = { removed.add(it) }
        val got = mutableListOf<FleetUpdate>()
        backgroundScope.launch { fleet.updates().collect { got.add(it) } }
        runCurrent()
        val ev = HubEvent(obj("type" to "info", "agent" to "a"))
        clients.getValue("m1").stream.send(FleetClient.Update.State(ConnectionState.ONLINE))
        clients.getValue("m2").stream.send(FleetClient.Update.Event(ev))
        clients.getValue("m2").stream.close(HubError.Unauthorized)
        runCurrent()
        assertEquals(
            listOf(FleetUpdate.State("m1", ConnectionState.ONLINE), FleetUpdate.Event("m2", ev), FleetUpdate.State("m2", ConnectionState.OFFLINE)),
            got,
        )
        assertEquals(listOf("m2"), removed)
        assertEquals(listOf(FleetMachine("m1", "n-m1"), FleetMachine("m2", "n-m2")), fleet.machines)
    }

    @Test fun onlyNewOrRepairedMachinesGetNewConnections() = runTest {
        var made = 0
        val fleet = LiveFleet(listOf(machine("m1")), backgroundScope) { m -> made++; FakeClient(m) }
        assertEquals(1, made)
        assertEquals(emptySet<String>(), fleet.setMachines(listOf(machine("m1").copy(name = "renamed"))))
        assertEquals(setOf("m1", "m2"), fleet.setMachines(listOf(machine("m1", d = "new"), machine("m2"))))
        assertEquals(3, made)
        assertEquals(obj("agent" to "a"), fleet.agentCall("m2", "a", "snapshot", EmptyObject))
        fleet.setMachines(listOf(machine("m2")))
        val error = runCatching { fleet.rpc("m1", "hub", EmptyObject) }.exceptionOrNull()
        assertEquals("That computer isn't paired with this phone.", error?.message)
    }
}
