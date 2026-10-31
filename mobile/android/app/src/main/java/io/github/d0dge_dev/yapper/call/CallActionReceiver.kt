package io.github.d0dge_dev.yapper.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Notification buttons that don't open the app: hang up the ongoing call, decline a ring. */
class CallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_HANGUP = "io.github.d0dge_dev.yapper.call.HANGUP"
        const val ACTION_DECLINE = "io.github.d0dge_dev.yapper.call.DECLINE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        CallRegistry.init(context)
        when (intent.action) {
            ACTION_HANGUP -> CallRegistry.hangupFromNative()
            ACTION_DECLINE -> intent.getStringExtra(YapTelecom.EXTRA_CALL_ID)?.let { CallRegistry.decline(context, it) }
        }
    }
}
