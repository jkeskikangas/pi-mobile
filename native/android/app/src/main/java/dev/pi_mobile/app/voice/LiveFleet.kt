package dev.pi_mobile.app.voice

import dev.pi_mobile.app.core.ConnectionState
import dev.pi_mobile.app.core.EmptyObject
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.HubEvent
import dev.pi_mobile.app.core.HubInfo
import dev.pi_mobile.app.core.Machine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * One computer's sealed connection as voice mode needs it: the slice of `core.HubClient` LiveFleet uses.
 * The app adapts its HubClient to this, so voice builds and tests without the networking layer.
 */
interface FleetClient {
    suspend fun rpc(m: String, p: JsonObject = EmptyObject): JsonElement
    suspend fun agent(agent: String, m: String, p: JsonObject): JsonElement
    suspend fun hub(): HubInfo
    suspend fun focus(agent: String)
    /** Connection states and hub events; ends with [HubError.Unauthorized] when this phone was removed there. */
    fun updates(): Flow<Update>

    sealed interface Update {
        data class State(val state: ConnectionState) : Update
        data class Event(val event: HubEvent) : Update
    }
}

/**
 * Voice mode's own connections to every paired machine (plans/native-apps.md §1 "Machines"): one
 * sealed RPC client and one event stream per machine, merged. Separate from the web view's. Follows the
 * app's machine list while voice mode runs ([setMachines]). Port of native/ios/Pi/Voice/LiveFleet.swift.
 *
 * Runs on [scope]'s (main) dispatcher, like the engine.
 */
class LiveFleet(
    list: List<Machine>,
    private val scope: CoroutineScope,
    private val connect: (Machine) -> FleetClient,
) : VoiceFleet {
    private val paired = mutableMapOf<String, Machine>()
    private val clients = mutableMapOf<String, FleetClient>()
    private val jobs = mutableMapOf<String, Job>()
    private var out: SendChannel<FleetUpdate>? = null
    override var machines: List<FleetMachine> = emptyList()
        private set

    /** A machine answered 401: this phone was removed there (the app verifies and forgets it). */
    var onUnauthorized: ((String) -> Unit)? = null

    init {
        setMachines(list)
    }

    private fun client(id: String): FleetClient =
        clients[id] ?: throw HubError.Network("That computer isn't paired with this phone.")

    override fun setMachines(list: List<Machine>): Set<String> {
        val changed = mutableSetOf<String>()
        for (id in paired.keys.toList()) if (list.none { it.id == id }) {
            jobs.remove(id)?.cancel()
            clients.remove(id)
            paired.remove(id)
        }
        // Only a new credential or address needs a new connection (`lastSeen`/name updates don't).
        for (m in list) {
            val old = paired[m.id]
            if (old != null && old.d == m.d && old.k == m.k && old.origin == m.origin) continue
            // New or re-paired (new d/k/origin): a fresh client and stream.
            changed.add(m.id)
            jobs.remove(m.id)?.cancel()
            paired[m.id] = m
            // A damaged key or a refused origin: no client; its calls say it isn't paired.
            val client = runCatching { connect(m) }.getOrNull()
            if (client == null) clients.remove(m.id) else clients[m.id] = client
            if (out != null) open(m.id)
        }
        for (m in list) paired[m.id] = m
        machines = list.map { FleetMachine(it.id, it.name) }
        return changed
    }

    override suspend fun rpc(machine: String, m: String, p: JsonElement): JsonElement =
        client(machine).rpc(m, p as? JsonObject ?: EmptyObject)

    override suspend fun agentCall(machine: String, agent: String, m: String, p: JsonElement): JsonElement =
        client(machine).agent(agent, m, p as? JsonObject ?: EmptyObject)

    override suspend fun focus(machine: String, agent: String) {
        catching { clients[machine]?.focus(agent) }
    }

    override fun updates(): Flow<FleetUpdate> {
        val channel = Channel<FleetUpdate>(Channel.UNLIMITED)
        out = channel
        for (id in clients.keys) open(id)
        return channel.consumeAsFlow().onCompletion { if (out === channel) close() }
    }

    override fun reconnect() {
        val ids = clients.keys.toList()
        close()
        for (id in ids) open(id)
    }

    private fun open(id: String) {
        val channel = out ?: return
        val c = clients[id] ?: return
        jobs.remove(id)?.cancel()
        jobs[id] = scope.launch {
            try {
                c.updates().collect { u ->
                    channel.trySend(
                        when (u) {
                            is FleetClient.Update.State -> FleetUpdate.State(id, u.state)
                            is FleetClient.Update.Event -> FleetUpdate.Event(id, u.event)
                        },
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: HubError.Unauthorized) {
                channel.trySend(FleetUpdate.State(id, ConnectionState.OFFLINE))
                onUnauthorized?.invoke(id)
            } catch (e: Exception) {
                channel.trySend(FleetUpdate.State(id, ConnectionState.OFFLINE))
            }
        }
    }

    private fun close() {
        jobs.values.forEach { it.cancel() }
        jobs.clear()
    }
}
