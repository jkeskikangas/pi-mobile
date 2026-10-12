package dev.pi_mobile.app.shell

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Whether the phone has a usable network, and a counter of changes, so the offline screen retries the moment Wi-Fi or
 * the tailnet comes back instead of waiting out its backoff. App-scoped: registered once for the process lifetime.
 * Port of native/ios/Pi/Shell/NetworkWatch.swift.
 */
class NetworkWatch(context: Context) {
    private val _online = MutableStateFlow(true)
    private val _changes = MutableStateFlow(0)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    /** Bumped on every default-network change (a VPN such as Tailscale coming up counts). */
    val changes: StateFlow<Int> = _changes.asStateFlow()

    init {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = changed(true)
            override fun onLost(network: Network) = changed(false)
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val ok = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                if (ok != _online.value) changed(ok)
            }
        })
    }

    private fun changed(ok: Boolean) {
        _online.value = ok
        _changes.update { it + 1 }
    }
}
