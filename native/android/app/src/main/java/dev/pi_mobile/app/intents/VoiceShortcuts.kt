package dev.pi_mobile.app.intents

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.pi_mobile.app.R
import dev.pi_mobile.app.voice.VoiceHost

/**
 * The launcher's "Talk to pi" shortcut (plan A11; the Siri phrase's counterpart). Dynamic rather than declared in
 * the manifest, because a manifest shortcut can't be disabled: with no computer paired it is removed, and a copy
 * pinned to the home screen is greyed out with "Pair a computer first".
 */
object VoiceShortcuts {
    const val ID = "talk-to-pi"

    /** The app calls this at launch and whenever its machine list changes. */
    fun update(context: Context, paired: Boolean) {
        if (paired) {
            val shortcut = ShortcutInfoCompat.Builder(context, ID)
                .setShortLabel(context.getString(R.string.voice_shortcut_short))
                .setLongLabel(context.getString(R.string.voice_shortcut_long))
                .setDisabledMessage(context.getString(R.string.voice_shortcut_disabled))
                .setIcon(IconCompat.createWithResource(context, R.drawable.voice_notification))
                // Launchers want an action; the extra is what LaunchRequest reads.
                .setIntent(VoiceHost.openIntent(context).setAction(Intent.ACTION_VIEW))
                .build()
            ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
            ShortcutManagerCompat.enableShortcuts(context, listOf(shortcut))
        } else {
            ShortcutManagerCompat.removeDynamicShortcuts(context, listOf(ID))
            ShortcutManagerCompat.disableShortcuts(context, listOf(ID), context.getString(R.string.voice_shortcut_disabled))
        }
    }
}
