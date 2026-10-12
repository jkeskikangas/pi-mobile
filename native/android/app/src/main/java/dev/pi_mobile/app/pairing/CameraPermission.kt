package dev.pi_mobile.app.pairing

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect

/** Where the camera permission stands, in the steps of Android's flow: ask → rationale → Open settings. */
enum class CameraAccess {
    GRANTED,

    /** Never asked (or the system will show its dialog again). */
    ASK,

    /** Declined once: explain why before asking again. */
    RATIONALE,

    /** Declined for good: only Settings can turn it on; pasting the link still works. */
    DENIED,
}

/** The camera permission for QR pairing, re-read whenever the app comes back (the user may have changed it in Settings). */
@Stable
class CameraPermission internal constructor(private val context: Context) {
    var access: CameraAccess by mutableStateOf(CameraAccess.ASK)
        private set

    /** Phones without a camera (some tablets, Chromebooks) never see Scan. */
    val hasCamera: Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    internal var onResult: (Boolean) -> Unit = {}
    internal var launch: () -> Unit = {}

    /** Shows the system dialog (or answers at once when the user declined for good); [then] gets the outcome. */
    fun request(then: (Boolean) -> Unit) {
        if (access == CameraAccess.GRANTED) return then(true)
        onResult = then
        launch()
    }

    /** The app's page in system Settings, where a permanently declined permission is turned back on. */
    fun openSettings() {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    internal fun refresh(afterRequest: Boolean = false) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        val rationale = context.findActivity()?.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA) == true
        access = when {
            granted -> CameraAccess.GRANTED
            rationale -> CameraAccess.RATIONALE
            // No rationale right after a refusal means "don't ask again": the system dialog won't show any more.
            afterRequest || access == CameraAccess.DENIED -> CameraAccess.DENIED
            else -> CameraAccess.ASK
        }
    }
}

@Composable
fun rememberCameraPermission(): CameraPermission {
    val context = LocalContext.current
    val permission = remember(context) { CameraPermission(context).apply { refresh() } }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        permission.refresh(afterRequest = !ok)
        permission.onResult(ok)
        permission.onResult = {}
    }
    SideEffect { permission.launch = { launcher.launch(Manifest.permission.CAMERA) } }
    LifecycleResumeEffect(permission) {
        permission.refresh()
        onPauseOrDispose {}
    }
    return permission
}

internal tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
