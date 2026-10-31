package io.github.d0dge_dev.yapper.call

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import android.graphics.Bitmap
import android.graphics.Canvas
import io.github.d0dge_dev.yapper.MainActivity
import io.github.d0dge_dev.yapper.R
import io.github.d0dge_dev.yapper.ring.RingMessage

/**
 * Channels and notifications for calls:
 *  - `call_active`   ongoing call (CallStyle, FGS): IMPORTANCE_DEFAULT but silent, so the Pixel shows it on the
 *                    lock screen (it hides "silent" = LOW notifications there) and the status bar gets the call chip.
 *  - `call_incoming` callback ringing: IMPORTANCE_HIGH with the ringtone (insistent) and a full-screen intent.
 *  - `call_missed`   "Verpasster Rückruf: <title>", tap opens the thread.
 * The phase-1 channel `call_ongoing` (IMPORTANCE_LOW) is deleted; channel importance can't be raised in place.
 */
object Notifications {
    private const val TAG = "YapNotifications"
    const val CHANNEL_ACTIVE = "call_active"
    const val CHANNEL_INCOMING = "call_incoming"
    const val CHANNEL_MISSED = "call_missed"
    private const val OLD_CHANNEL = "call_ongoing"

    const val ID_ONGOING = 1
    private const val ID_RING_BASE = 1000
    private const val ID_MISSED_BASE = 2000

    /** Yapper's colour (the violet of the glow), used to tint call notifications. */
    private const val BRAND = 0xFF7C5CF6.toInt()

    private var avatarCache: Bitmap? = null

    /** The app icon (glow + sound waves) as a bitmap for the caller's avatar; the system crops it round. */
    private fun avatar(context: Context): Bitmap = avatarCache ?: run {
        val size = 192
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        // Adaptive-icon layers are 108dp with the visible part in the middle 72dp: draw them 1.5x and centre.
        val full = size * 108 / 72
        val off = (size - full) / 2
        for (id in intArrayOf(R.drawable.ic_launcher_bg, R.drawable.ic_launcher_foreground)) {
            ContextCompat.getDrawable(context, id)?.apply { setBounds(off, off, off + full, off + full); draw(canvas) }
        }
        bmp.also { avatarCache = it }
    }

    private fun yapper(context: Context) = Person.Builder()
        .setName(context.getString(R.string.ring_caller))
        .setIcon(IconCompat.createWithBitmap(avatar(context)))
        .setImportant(true)
        .build()

    fun ringId(callId: String) = ID_RING_BASE + (callId.hashCode() and 0xfff)
    fun missedId(callId: String) = ID_MISSED_BASE + (callId.hashCode() and 0xfff)

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(OLD_CHANNEL) != null) nm.deleteNotificationChannel(OLD_CHANNEL)
        if (nm.getNotificationChannel(CHANNEL_ACTIVE) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ACTIVE, context.getString(R.string.call_channel_name), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = context.getString(R.string.call_channel_description)
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
            )
        }
        if (nm.getNotificationChannel(CHANNEL_INCOMING) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_INCOMING, context.getString(R.string.ring_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = context.getString(R.string.ring_channel_description)
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
                    setShowBadge(false)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
            )
        }
        if (nm.getNotificationChannel(CHANNEL_MISSED) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_MISSED, context.getString(R.string.missed_channel_name), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = context.getString(R.string.missed_channel_description)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
            )
        }
    }

    /** Android 14+: may this app's full-screen intent take over the (locked) screen? */
    fun canUseFullScreenIntent(context: Context): Boolean =
        Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()

    private const val PI = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    private fun actionIntent(context: Context, action: String, callId: String?, code: Int) = PendingIntent.getBroadcast(
        context, code,
        Intent(context, CallActionReceiver::class.java).setAction(action).putExtra(YapTelecom.EXTRA_CALL_ID, callId),
        PI,
    )

    // ---- ongoing

    fun ongoing(context: Context, title: String, since: Long): Notification {
        ensureChannels(context)
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PI,
        )
        val hangup = actionIntent(context, CallActionReceiver.ACTION_HANGUP, null, 1)
        return NotificationCompat.Builder(context, CHANNEL_ACTIVE)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(context.getString(R.string.ring_caller))
            .setContentText(title)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(yapper(context), hangup))
            .setColor(BRAND)
            .setColorized(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(true)
            .setWhen(since)
            .setUsesChronometer(true)
            .setContentIntent(open)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    // ---- incoming

    /** Posts (or, with [silent], re-posts without ringtone) the incoming-call notification for [ring]. */
    fun showIncoming(context: Context, ring: RingMessage, silent: Boolean = false, timeoutMs: Long) {
        ensureChannels(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        val code = ringId(ring.callId)
        val fullScreen = PendingIntent.getActivity(context, code, IncomingCallActivity.intent(context, ring), PI)
        val answer = PendingIntent.getActivity(context, code + 1, MainActivity.answerIntent(context, ring.callId, ring.threadId), PI)
        val decline = actionIntent(context, CallActionReceiver.ACTION_DECLINE, ring.callId, code + 2)
        val caller = yapper(context)
        fun base() = NotificationCompat.Builder(context, CHANNEL_INCOMING)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(BRAND)
            .setLargeIcon(avatar(context))
            .setContentTitle(context.getString(R.string.ring_caller))
            .setContentText(ring.title)
            .setSubText(ring.reasonText)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setSilent(silent)
            .setTimeoutAfter(timeoutMs)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
        val callStyle = base()
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
            .build()
            .apply { if (!silent) flags = flags or Notification.FLAG_INSISTENT }
        try {
            nm.notify(code, callStyle)
        } catch (e: Exception) {
            // CallStyle needs an FGS, a full-screen intent or an active Telecom call; without them NMS refuses it.
            Log.w(TAG, "CallStyle incoming notification refused, posting a plain one", e)
            val plain = base()
                .addAction(R.drawable.ic_call_end, context.getString(R.string.ring_decline), decline)
                .addAction(R.drawable.ic_call, context.getString(R.string.ring_answer), answer)
                .build()
                .apply { if (!silent) flags = flags or Notification.FLAG_INSISTENT }
            try { nm.notify(code, plain) } catch (e2: Exception) { Log.w(TAG, "incoming notification failed", e2) }
        }
    }

    fun cancelIncoming(context: Context, callId: String) =
        context.getSystemService(NotificationManager::class.java).cancel(ringId(callId))

    // ---- missed

    fun showMissed(context: Context, ring: RingMessage) {
        ensureChannels(context)
        val code = missedId(ring.callId)
        val open = PendingIntent.getActivity(context, code, MainActivity.openThreadIntent(context, ring.threadId), PI)
        val n = NotificationCompat.Builder(context, CHANNEL_MISSED)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(context.getString(R.string.missed_title, ring.title))
            .setContentText(context.getString(R.string.missed_text, ring.reasonText))
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setColor(BRAND)
            .setLargeIcon(avatar(context))
            .setWhen(ring.at)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(code, n)
        } catch (e: Exception) {
            Log.w(TAG, "missed notification failed", e)
        }
    }
}
