package dev.pi_mobile.app.push

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import dev.pi_mobile.app.core.Prefs
import kotlinx.coroutines.CompletableDeferred

/**
 * Whether pi may post notifications, in the words of BRIDGE.md `push.status`: `granted`, `denied` (asking
 * again shows nothing: the user has to go to Settings) or `default` (asking shows the system dialog).
 * A seam so [dev.pi_mobile.app.PushCenter] runs on the JVM.
 */
interface NotificationPermission {
    /** Shows the system dialog when it can; true when notifications may be posted afterwards. */
    suspend fun request(): Boolean

    fun state(): String

    companion object {
        /**
         * Android doesn't say whether the dialog would still show, so [asked] (did pi ever ask?) separates
         * `default` from `denied`. Below API 33 there is no runtime permission: only the Settings switch.
         */
        fun state(notificationsEnabled: Boolean, runtimePermission: Boolean, asked: Boolean): String = when {
            notificationsEnabled -> "granted"
            runtimePermission && !asked -> "default"
            else -> "denied"
        }
    }
}

/**
 * The real permission. `POST_NOTIFICATIONS` is asked only from the web's Turn on notifications
 * (plans/native-android.md step 7), never at launch, so the request needs the activity on screen:
 * MainActivity calls [attach] in `onCreate` (activity-result launchers must be registered before STARTED).
 */
class SystemNotificationPermission(context: Context) : NotificationPermission {
    private val app = context.applicationContext
    private val sp = app.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
    private var launcher: ActivityResultLauncher<String>? = null
    private var pending: CompletableDeferred<Boolean>? = null

    fun attach(activity: ComponentActivity) {
        val l = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pending?.complete(granted)
            pending = null
        }
        launcher = l
        activity.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) {
                if (launcher === l) launcher = null
                // A rotation mid-dialog: the answer goes to the new activity's launcher, so this wait ends as "no".
                pending?.complete(false)
                pending = null
            }
        })
    }

    override suspend fun request(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || granted()) return enabled()
        val l = launcher ?: return false
        sp.edit { putBoolean(ASKED, true) }
        val answer = CompletableDeferred<Boolean>().also { pending?.complete(false); pending = it }
        l.launch(Manifest.permission.POST_NOTIFICATIONS)
        return answer.await() && enabled()
    }

    override fun state(): String = NotificationPermission.state(
        notificationsEnabled = enabled(),
        runtimePermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted(),
        asked = sp.getBoolean(ASKED, false),
    )

    private fun enabled() = NotificationManagerCompat.from(app).areNotificationsEnabled()

    private fun granted() = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private companion object {
        const val ASKED = "pi-push-asked"
    }
}
