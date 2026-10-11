package dev.pi_mobile.app

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

/** Placeholder that reserves the package name on Google Play; the real app comes later (plans/native-android.md). */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(
            TextView(this).apply {
                text = getString(R.string.coming_soon)
                textSize = 20f
                gravity = Gravity.CENTER
            },
        )
    }
}
