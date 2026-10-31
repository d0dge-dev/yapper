package io.github.d0dge_dev.yapper.call

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import androidx.core.content.ContextCompat
import io.github.d0dge_dev.yapper.R
import io.github.d0dge_dev.yapper.ring.RingMessage

/**
 * The self-managed PhoneAccount ("yap") and the two ways into Telecom: [placeCall] for a call started in the
 * app and [addIncoming] for a callback ring. Self-managed means yap draws its own call UI; Telecom still treats
 * it as a call: audio mode/focus/routing, Bluetooth and car buttons, and a GSM call ends it (no hold).
 * Needs only MANAGE_OWN_CALLS (an install-time permission).
 */
object YapTelecom {
    private const val TAG = "YapTelecom"
    private const val ACCOUNT_ID = "yap"
    const val EXTRA_CALL_ID = "io.github.d0dge_dev.yapper.callId"
    const val EXTRA_THREAD_ID = "io.github.d0dge_dev.yapper.threadId"
    const val EXTRA_TITLE = "io.github.d0dge_dev.yapper.title"
    const val EXTRA_REASON = "io.github.d0dge_dev.yapper.reason"
    const val EXTRA_AT = "io.github.d0dge_dev.yapper.at"

    @Volatile private var registered = false

    fun handle(context: Context) = PhoneAccountHandle(ComponentName(context, YapConnectionService::class.java), ACCOUNT_ID)

    /** What Telecom (and a car or headset display) shows as the other side. */
    val address: Uri = Uri.fromParts(PhoneAccount.SCHEME_SIP, "yap", null)

    private fun telecom(context: Context) = context.getSystemService(TelecomManager::class.java)

    /** Registers the PhoneAccount once per process (idempotent on the Telecom side as well). */
    fun ensureAccount(context: Context): Boolean {
        if (registered) return true
        return try {
            val account = PhoneAccount.builder(handle(context), context.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_SIP))
                .setShortDescription(context.getString(R.string.app_name))
                .setIcon(Icon.createWithResource(context, R.drawable.ic_stat_call))
                .build()
            telecom(context).registerPhoneAccount(account)
            registered = true
            true
        } catch (e: Exception) {
            Log.w(TAG, "registerPhoneAccount failed", e)
            false
        }
    }

    /** Asks Telecom for an outgoing call; the answer comes as onCreateOutgoingConnection(Failed). */
    fun placeCall(context: Context, title: String, speaker: Boolean): Boolean {
        if (!ensureAccount(context)) return false
        // MANAGE_OWN_CALLS is an install-time permission; checked anyway so placeCall can't throw for it.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.MANAGE_OWN_CALLS) != PackageManager.PERMISSION_GRANTED) return false
        val handle = handle(context)
        return try {
            val tm = telecom(context)
            if (Build.VERSION.SDK_INT >= 28 && !tm.isOutgoingCallPermitted(handle)) {
                Log.i(TAG, "outgoing call not permitted right now (another call?)")
                return false
            }
            tm.placeCall(address, Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                putBoolean(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, speaker)
                putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, Bundle().apply { putString(EXTRA_TITLE, title) })
            })
            true
        } catch (e: Exception) {
            Log.w(TAG, "placeCall failed", e)
            false
        }
    }

    /** Hands a ring to Telecom; it calls back onCreateIncomingConnection(Failed). False: ring without Telecom. */
    fun addIncoming(context: Context, ring: RingMessage): Boolean {
        if (!ensureAccount(context)) return false
        val handle = handle(context)
        return try {
            val tm = telecom(context)
            if (Build.VERSION.SDK_INT >= 28 && !tm.isIncomingCallPermitted(handle)) {
                Log.i(TAG, "incoming call not permitted right now (another call?)")
                return false
            }
            tm.addNewIncomingCall(handle, Bundle().apply {
                putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, address)
                putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, Bundle().apply {
                    putString(EXTRA_CALL_ID, ring.callId)
                    putString(EXTRA_THREAD_ID, ring.threadId)
                    putString(EXTRA_TITLE, ring.title)
                    putString(EXTRA_REASON, ring.reason)
                    putLong(EXTRA_AT, ring.at)
                })
            })
            true
        } catch (e: Exception) {
            Log.w(TAG, "addNewIncomingCall failed", e)
            false
        }
    }
}
