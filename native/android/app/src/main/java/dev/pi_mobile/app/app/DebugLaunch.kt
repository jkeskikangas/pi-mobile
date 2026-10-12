package dev.pi_mobile.app.app

import android.content.Intent

/**
 * Debug-build launch extras, the counterparts of the iOS app's launch arguments (screenshots and end-to-end runs
 * without a camera), e.g. `adb shell am start -n dev.pi_mobile.app/.app.MainActivity --ez piReset true --es piPairLink
 * 'http://127.0.0.1:7995/#p=…'`. MainActivity reads them only when BuildConfig.DEBUG.
 *
 * @property reset forget every computer and the voice consent first (`-PiReset`).
 * @property pairLink pair with this link at launch (`-PiPairLink <url>`).
 */
data class DebugLaunch(val reset: Boolean, val pairLink: String?) {
    companion object {
        const val RESET = "piReset"
        const val PAIR_LINK = "piPairLink"

        /** null when the intent carries none of the extras. */
        fun from(intent: Intent?): DebugLaunch? {
            val extras = intent?.extras ?: return null
            val d = DebugLaunch(extras.getBoolean(RESET), extras.getString(PAIR_LINK))
            return d.takeIf { it.reset || it.pairLink != null }
        }
    }
}
