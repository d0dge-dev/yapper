package io.github.d0dge_dev.yapper.ring

import android.app.Activity
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.content.edit
import io.github.d0dge_dev.yapper.call.CallBus
import org.unifiedpush.android.connector.UnifiedPush

/**
 * UnifiedPush registration. The endpoint (a URL on the distributor's server, e.g. ntfy) is kept here and
 * handed to the web app ([CallBus.onEndpoint] / YapCall.setup), which POSTs it to /api/push/register with
 * the login cookie: native code never talks to the yap server itself.
 */
object Push {
    private const val TAG = "YapPush"
    private const val PREFS = "yap.push"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_SEEN = "seen"
    const val INSTANCE = "default"

    /** Sent to the server with the endpoint; one entry per phone there. */
    val device: String get() = Build.MODEL ?: "Android"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun endpoint(context: Context): String? = prefs(context).getString(KEY_ENDPOINT, null)

    fun saveEndpoint(context: Context, url: String?) {
        prefs(context).edit { if (url == null) remove(KEY_ENDPOINT) else putString(KEY_ENDPOINT, url) }
        if (url != null) CallBus.onEndpoint?.invoke(url)
    }

    fun distributor(context: Context): String? = try {
        UnifiedPush.getAckDistributor(context) ?: UnifiedPush.getSavedDistributor(context)
    } catch (e: Exception) {
        null
    }

    fun distributors(context: Context): List<String> = try {
        UnifiedPush.getDistributors(context)
    } catch (e: Exception) {
        emptyList()
    }

    /**
     * Uses the saved distributor, else the system default (ntfy, if it's the only one), and (re-)registers.
     * Registering again is cheap and makes the distributor resend the endpoint if it changed.
     */
    fun register(activity: Activity, pick: Boolean = false) {
        val then: (Boolean) -> Unit = { ok ->
            if (ok) {
                try {
                    UnifiedPush.register(activity, INSTANCE, "yap Rückrufe", null)
                } catch (e: Exception) {
                    Log.w(TAG, "register failed", e)
                }
            } else {
                Log.i(TAG, "no UnifiedPush distributor (install ntfy and allow UnifiedPush there)")
            }
        }
        try {
            if (pick) UnifiedPush.tryPickDistributor(activity, then) else UnifiedPush.tryUseCurrentOrDefaultDistributor(activity, then)
        } catch (e: Exception) {
            Log.w(TAG, "distributor selection failed", e)
        }
    }

    /** False if [callId] was already handled (a push redelivered after a reconnect or a restart). */
    fun firstTime(context: Context, callId: String): Boolean {
        val p = prefs(context)
        val seen = p.getString(KEY_SEEN, "")!!.split('\n').filter { it.isNotBlank() }
        if (callId in seen) return false
        p.edit { putString(KEY_SEEN, (seen + callId).takeLast(50).joinToString("\n")) }
        return true
    }
}
