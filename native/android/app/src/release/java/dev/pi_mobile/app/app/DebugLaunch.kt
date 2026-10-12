package dev.pi_mobile.app.app

import android.content.Intent

/** Release builds take no launch extras (src/debug has the real one: reset, pair link). */
data class DebugLaunch(val reset: Boolean, val pairLink: String?) {
    companion object {
        @Suppress("UNUSED_PARAMETER")
        fun from(intent: Intent?): DebugLaunch? = null
    }
}
