package dev.pi_mobile.app.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import dev.pi_mobile.app.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Firebase without the google-services plugin (plans/native-android.md A14): the options come from Gradle
 * properties through BuildConfig, so builds and tests run without a Firebase project, and a build without
 * them simply has no push (`push.status` `available: false`).
 */
object FirebaseSetup {
    /** All four values were given at build time. */
    val available: Boolean = configured(
        BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_SENDER_ID,
    )

    fun configured(vararg values: String): Boolean = values.all { it.isNotBlank() }

    /**
     * Initialises the default FirebaseApp once (PiApplication.onCreate, before FCM can deliver anything).
     * False when this build has no Firebase configuration.
     */
    @Synchronized
    fun init(context: Context): Boolean {
        if (!available) return false
        if (FirebaseApp.getApps(context).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                .build()
            FirebaseApp.initializeApp(context.applicationContext, options)
        }
        return true
    }

    /**
     * The FCM registration token, or null (no Firebase in this build, no Google Play services, offline).
     * Auto-init is off in the manifest so no token exists before the user turns notifications on; asking
     * for one turns it on, so later rotations reach [PiMessagingService.onNewToken].
     */
    suspend fun token(context: Context): String? {
        if (!init(context)) return null
        return try {
            val fcm = FirebaseMessaging.getInstance()
            fcm.isAutoInitEnabled = true
            withTimeoutOrNull(TOKEN_TIMEOUT_MS) { fcm.token.await() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    private const val TOKEN_TIMEOUT_MS = 15_000L

    /** The task's result, or null when it failed. */
    private suspend fun <T> Task<T>.await(): T? = suspendCancellableCoroutine { c ->
        addOnCompleteListener { t -> c.resume(if (t.isSuccessful) t.result else null) }
    }
}
