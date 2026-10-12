package dev.pi_mobile.app.shell

import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred

/** The outcome of a runtime permission request. */
enum class PermissionResult {
    GRANTED,

    /** The user said no in the system dialog just now (asking again later can still show it). */
    DENIED,

    /** No dialog was shown ("Don't ask again" or policy): only Settings can turn it on, so offer to open them. */
    BLOCKED,
}

/**
 * Runtime permissions for app-scoped features (dictation's microphone, the scanner's camera) that are asked from a
 * bridge call, i.e. while the activity is in front. The activity [attach]es its launcher on create; without one
 * (no UI in front) a missing permission reads as [PermissionResult.DENIED].
 */
class Permissions(private val context: Context) {
    private var asker: Asker? = null

    fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    suspend fun request(permission: String): PermissionResult {
        if (granted(permission)) return PermissionResult.GRANTED
        return asker?.request(permission) ?: PermissionResult.DENIED
    }

    /** Registers the activity's launcher; call from `onCreate` (ActivityResult launchers must exist before STARTED). */
    fun attach(activity: ComponentActivity) {
        asker = Asker(activity)
    }

    fun detach(activity: ComponentActivity) {
        if (asker?.activity === activity) asker = null
    }

    private class Asker(val activity: ComponentActivity) {
        /** The permission whose system dialog is up, and its answer. */
        private var pending: Pair<String, CompletableDeferred<Boolean>>? = null
        private val launcher = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
            pending?.second?.complete(ok)
            pending = null
        }

        suspend fun request(permission: String): PermissionResult {
            // One system dialog at a time: a caller for the same permission shares its answer, another one waits.
            while (true) {
                val (p, answer) = pending ?: break
                if (p == permission) return result(permission, answer.await())
                answer.await()
            }
            val answer = CompletableDeferred<Boolean>()
            pending = permission to answer
            launcher.launch(permission)
            return result(permission, answer.await())
        }

        private fun result(permission: String, ok: Boolean): PermissionResult {
            if (ok) return PermissionResult.GRANTED
            // After a denial the rationale flag is true while the dialog may still be shown again; false means the
            // system no longer shows it.
            return if (activity.shouldShowRequestPermissionRationale(permission)) PermissionResult.DENIED else PermissionResult.BLOCKED
        }
    }
}
