package dev.pi_mobile.app.core

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Which hub addresses the app talks to (native/ios/README.md → ATS; plans/native-android.md A5): HTTPS only.
 * The one exception is loopback (127.0.0.1, localhost, ::1) over plain HTTP, so the emulator can reach the
 * `npm run ui` fixture through `adb reverse`. A plain-HTTP computer (LAN, Tailscale 100.x, .local) is refused
 * with a sentence that says how to get its secure address. Port of native/ios/Pi/Core/OriginPolicy.swift.
 */
object OriginPolicy {
    const val README = "https://github.com/jkeskikangas/pi-mobile#https-and-lock-screen-notifications"
    const val PLAIN_HTTP_MESSAGE =
        "This computer needs its secure address. Install Tailscale on it and this phone, run /remote in pi there, and scan the new code ($README)."
    private const val INVALID = "That computer's address isn't valid. Pair it again."

    /** null when the app may use [origin], else the sentence to show. */
    fun problem(origin: String): String? {
        val url = origin.toHttpUrlOrNull() ?: return INVALID
        if (url.host.isEmpty()) return INVALID
        if (url.isHttps) return null
        return if (isLoopback(url.host)) null else PLAIN_HTTP_MESSAGE
    }

    fun isLoopback(rawHost: String): Boolean {
        val host = rawHost.trim('[', ']').lowercase()
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    /**
     * Hub requests never follow a redirect off their own origin: a hub could otherwise send the phone to a
     * plain-HTTP or foreign address. Same scheme, host and port, and the target must pass [problem].
     */
    fun allowsRedirect(from: HttpUrl?, to: HttpUrl?): Boolean {
        if (from == null || to == null || problem(to.toString()) != null) return false
        return from.scheme == to.scheme && from.host == to.host && from.port == to.port
    }
}

/**
 * Follows only the redirects [OriginPolicy.allowsRedirect] accepts; any other 3xx is returned as is and
 * fails as an HTTP error. Install it on a client built with `followRedirects(false)` and
 * `followSslRedirects(false)` (OkHttp's own follow-up would skip the rule). The RedirectGuard of the iOS app.
 */
object RedirectGuard : Interceptor {
    private const val MAX_HOPS = 5

    override fun intercept(chain: Interceptor.Chain): Response {
        var request = chain.request()
        var response = chain.proceed(request)
        repeat(MAX_HOPS) {
            if (!response.isRedirect) return response
            val target = response.header("Location")?.let { request.url.resolve(it) }
            if (!OriginPolicy.allowsRedirect(request.url, target)) return response
            // 307/308 repeat the request as is; the others become a GET, as URLSession and browsers do.
            val keep = response.code == 307 || response.code == 308
            request = request.newBuilder().url(target!!).apply { if (!keep) method("GET", null) }.build()
            response.close()
            response = chain.proceed(request)
        }
        return response
    }
}
