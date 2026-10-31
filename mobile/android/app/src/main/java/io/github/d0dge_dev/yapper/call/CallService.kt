package io.github.d0dge_dev.yapper.call

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.d0dge_dev.yapper.R

/**
 * Keeps a call alive with the screen locked or the app in the background. Still needed with Telecom:
 * Telecom keeps the process bound, but background mic capture needs a foreground service of type
 * `microphone`, and the CallStyle notification (hang-up button, status-bar call chip) needs a foreground
 * service as well. Also holds a partial wake lock for the WebSocket.
 *
 * The call itself (mic, WebRTC/WebSocket, playback) stays in the WebView; audio routing and the Telecom
 * connection are in [CallRegistry]. Started/stopped by [CallRegistry].
 */
class CallService : Service() {
    companion object {
        private const val ACTION_START = "io.github.d0dge_dev.yapper.call.START"
        private const val EXTRA_TITLE = "title"
        private const val WAKE_LOCK_MAX_MS = 4L * 60 * 60 * 1000 // safety net; endCall releases it

        fun start(context: Context, title: String) {
            val intent = Intent(context, CallService::class.java).setAction(ACTION_START).putExtra(EXTRA_TITLE, title)
            ContextCompat.startForegroundService(context, intent)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var startedAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: getString(R.string.call_default_title)
        if (startedAt == 0L) startedAt = System.currentTimeMillis()
        val notification = Notifications.ongoing(this, title, startedAt)
        try {
            ServiceCompat.startForeground(this, Notifications.ID_ONGOING, notification, types(withPhoneCall = true))
        } catch (e: Exception) {
            try {
                // phoneCall type refused (shouldn't happen with MANAGE_OWN_CALLS): microphone alone still keeps the call.
                ServiceCompat.startForeground(this, Notifications.ID_ONGOING, notification, types(withPhoneCall = false))
            } catch (e2: Exception) {
                // SecurityException without RECORD_AUDIO, or not allowed from the background (Android 14+).
                Log.w("YapCallService", "startForeground failed", e2)
                stopSelf()
                return START_NOT_STICKY
            }
        }
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "yap:call")
                .apply { acquire(WAKE_LOCK_MAX_MS) }
        }
        // Not sticky: after a process death there is no WebView call to keep alive.
        return START_NOT_STICKY
    }

    private fun types(withPhoneCall: Boolean): Int {
        var t = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        if (withPhoneCall && Build.VERSION.SDK_INT >= 29) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        return t
    }

    /** App swiped away from recents: the WebView (and the call) is gone. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        CallRegistry.hangupFromNative()
        stopSelf()
    }

    override fun onDestroy() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        super.onDestroy()
    }
}
