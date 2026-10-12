package dev.pi_mobile.app.app

import dev.pi_mobile.app.core.Base64Url
import dev.pi_mobile.app.core.Envelope
import dev.pi_mobile.app.core.HubClient
import dev.pi_mobile.app.core.HubError
import dev.pi_mobile.app.core.Machine
import dev.pi_mobile.app.core.MachineStore
import dev.pi_mobile.app.core.OriginPolicy
import dev.pi_mobile.app.core.PairingLink
import dev.pi_mobile.app.core.Prefs
import dev.pi_mobile.app.core.bool
import dev.pi_mobile.app.core.double
import dev.pi_mobile.app.core.get
import dev.pi_mobile.app.core.string
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient

/**
 * App state: the computers this phone uses ([MachineStore], the source of truth), the settings in [Prefs], and one
 * hub client per computer. Port of native/ios/Pi/App/AppModel.swift.
 *
 * Every change is stored before it is published: on a refused write nothing changes and the caller hears
 * [MachineStore.SaveFailed], so the page (which re-sends its list) or the user can retry. Thread-safe: the bridge
 * calls in on the main thread, while revocation checks resume on OkHttp's threads.
 *
 * @param http the OkHttp client hub requests share (tests point it at MockWebServer).
 */
class AppModel(
    private val store: MachineStore,
    val prefs: Prefs,
    private val http: OkHttpClient = HubClient.defaultClient,
) {
    private val lock = Any()
    private val _machines = MutableStateFlow(store.load())
    private val _forgetQueue = MutableStateFlow<List<Machine>>(emptyList())
    private val clients = mutableMapOf<String, HubClient>()

    /** The stored list, in stored order. Push (PushCenter) collects it to register with new computers. */
    val machines: StateFlow<List<Machine>> = _machines.asStateFlow()

    /** Computers the page dropped that still accept this phone: the user confirms ("Forget ‹name› on this phone?"). */
    val forgetQueue: StateFlow<List<Machine>> = _forgetQueue.asStateFlow()

    /** The computer that serves the web UI; null shows the pairing screen. */
    val primary: Machine? get() = primaryOf(_machines.value)

    /** Pairs with the computer that showed [link]; it becomes the primary one. Throws the sentence to show. */
    suspend fun pair(link: PairingLink) {
        val m = HubClient.pair(link, DEVICE_NAME, http)
        try {
            added(m)
        } catch (_: MachineStore.SaveFailed) {
            // The code is single use: say what to do instead of a bare "try again".
            throw HubError.Remote("Paired, but this phone couldn't save the key. Run /remote again and scan the new code.")
        }
    }

    /** A computer only appears once its key is safely stored. */
    fun added(m: Machine) = synchronized(lock) {
        commit(MachineStore.adding(m, _machines.value))
    }

    /** Serves the web UI from another computer (the primary one is unreachable). */
    fun makePrimary(m: Machine) = synchronized(lock) {
        val now = _machines.value
        if (now.none { it.id == m.id }) return
        commit(now.map { it.copy(primary = it.id == m.id) })
    }

    /** One sealed client per computer, rebuilt when it is re-paired; null when its key or origin is unusable. */
    fun client(m: Machine): HubClient? = synchronized(lock) {
        clients[m.id]?.takeIf { it.machine == m }?.let { return it }
        val c = try { HubClient(m, http) } catch (_: HubError) { null }
        if (c == null) clients.remove(m.id) else clients[m.id] = c
        c
    }

    /**
     * The other computers that answer right now (each serves the web UI too): what the offline screen offers when the
     * primary one can't be reached. A short budget per computer; this only decides which buttons to show.
     */
    suspend fun reachableOthers(primary: Machine): List<Machine> = coroutineScope {
        _machines.value.filter { it.id != primary.id }
            .map { m -> async { m.takeIf { client(m)?.let { c -> withTimeoutOrNull(PROBE_MS) { runCatching { c.hub() }.isSuccess } } == true } } }
            .awaitAll()
            .filterNotNull()
    }

    /** The session on screen in the web UI (bridge `focus`): "Start voice" picks it when no session needs you. */
    fun setFocus(agent: String, machine: String, name: String) {
        prefs.lastFocus = Prefs.Focus(agent, machine.ifEmpty { primary?.id ?: "" }, name)
    }

    // The page's list (BRIDGE.md `machines`, `unpaired`)

    /**
     * New or changed entries are stored (changed `d`/`k` = re-paired); a missing one goes only after its computer
     * answers 401 or the user confirms ([forgetQueue]). A list with a plain-HTTP computer changes nothing and
     * throws [OriginPolicy]'s sentence.
     */
    suspend fun webMachines(list: List<Machine>) {
        list.firstNotNullOfOrNull { OriginPolicy.problem(it.origin) }?.let { throw HubError.Remote(it) }
        val missing = synchronized(lock) {
            val before = _machines.value
            val next = before.toMutableList()
            for (m in list) {
                val i = next.indexOfFirst { it.id == m.id }
                if (i >= 0) next[i] = m else next += m
            }
            // Exactly one primary: the page's choice wins.
            list.firstOrNull { it.primary }?.let { p -> next.replaceAll { it.copy(primary = it.id == p.id) } }
            commit(next)
            before.filter { m -> list.none { it.id == m.id } }
        }
        reconcile(missing)
    }

    /** The page unpaired (BRIDGE.md `unpaired`): every computer goes through the same check as a removal. */
    suspend fun webUnpaired() = reconcile(_machines.value)

    /** Throws [MachineStore.SaveFailed] if a removal couldn't be written (the entry stays; the next message retries). */
    private suspend fun reconcile(candidates: List<Machine>) {
        var failed = false
        for (m in candidates) {
            val gone = revoked(m)
            synchronized(lock) {
                // The check crossed a suspension: act only if the stored entry is still the credential we checked.
                val now = _machines.value.firstOrNull { it.sameCredential(m) } ?: return@synchronized
                if (gone) {
                    if (!remove(now)) failed = true
                } else if (_forgetQueue.value.none { it.id == now.id }) {
                    _forgetQueue.update { it + now }
                }
            }
        }
        if (failed) throw MachineStore.SaveFailed()
    }

    /** True only when the computer says this phone was removed (401); unreachable keeps the key. */
    private suspend fun revoked(m: Machine): Boolean {
        val c = try { HubClient(m, http) } catch (_: HubError) { return true }
        return try {
            c.hub()
            false
        } catch (e: CancellationException) {
            throw e
        } catch (_: HubError.Unauthorized) {
            true
        } catch (_: Exception) {
            false
        }
    }

    /** The user confirmed: removes exactly the credential they were asked about (not a re-paired one). */
    fun forget(m: Machine) = synchronized(lock) {
        _forgetQueue.update { q -> q.filter { it.id != m.id } }
        _machines.value.firstOrNull { it.sameCredential(m) }?.let { remove(it) }
        Unit
    }

    fun keep(m: Machine) = _forgetQueue.update { q -> q.filter { it.id != m.id } }

    /** Drops every computer (debug reset). */
    fun forgetAll() = synchronized(lock) {
        store.clear()
        clients.clear()
        _forgetQueue.value = emptyList()
        _machines.value = emptyList()
    }

    /** Stored first, then published; false (and nothing changed) when the store refuses the write. */
    private fun remove(m: Machine): Boolean {
        var next = _machines.value.filter { it.id != m.id }
        if (next.isNotEmpty() && next.none { it.primary }) next = listOf(next[0].copy(primary = true)) + next.drop(1)
        try { store.save(next) } catch (_: MachineStore.SaveFailed) { return false }
        _machines.value = next
        clients.remove(m.id)
        return true
    }

    private fun commit(next: List<Machine>) {
        store.save(next)
        _machines.value = next
    }

    private fun Machine.sameCredential(o: Machine) = id == o.id && origin == o.origin && d == o.d && k == o.k

    companion object {
        /** How this phone is listed on the computer (`/remote` devices). */
        const val DEVICE_NAME = "Android · pi app"
        private const val PROBE_MS = 5_000L

        fun primaryOf(list: List<Machine>): Machine? = list.firstOrNull { it.primary } ?: list.firstOrNull()
    }
}

/**
 * An entry from the page's list (BRIDGE.md → Setup); null when it is malformed. The primary's `origin` is `""` there
 * (it is the page's own origin), so it gets [primaryOrigin].
 */
fun Machine.Companion.fromWeb(web: JsonElement, primaryOrigin: String): Machine? {
    val id = web["id"].string ?: return null
    val d = web["d"].string ?: return null
    val k = web["k"].string ?: return null
    if (Base64Url.decode(k)?.size != Envelope.KEY_BYTES) return null
    val primary = web["primary"].bool ?: false
    val origin = if (primary) primaryOrigin else web["origin"].string ?: ""
    if (origin.isEmpty()) return null
    return Machine(
        id = id, machine = web["machine"].string ?: "", name = web["name"].string ?: "", origin = origin, d = d, k = k,
        primary = primary, added = web["added"].double ?: 0.0, lastSeen = web["lastSeen"].double ?: 0.0,
    )
}
