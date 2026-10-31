package io.github.d0dge_dev.yapper.ring

import android.util.Log
import io.github.d0dge_dev.yapper.call.CallRegistry
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * UnifiedPush receiver (connector 3.x). The distributor (the ntfy app) wakes this up even when yap isn't
 * running; a ring goes to [CallRegistry.ring] → Telecom incoming call.
 */
class YapPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        Log.i(TAG, "new endpoint (${endpoint.url.substringBefore('?').substringAfter("://").substringBefore('/')})")
        Push.saveEndpoint(this, endpoint.url)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val body = message.content.toString(Charsets.UTF_8)
        RingMessage.parseCancel(body)?.let { callId ->
            // Mark it seen too, so a ring that arrives after its cancel doesn't start ringing.
            Push.firstTime(this, callId)
            CallRegistry.answeredElsewhere(this, callId)
            return
        }
        val ring = RingMessage.parse(body)
        if (ring == null) {
            Log.i(TAG, "ignoring push that isn't a ring")
            return
        }
        if (!ring.fresh()) {
            Log.i(TAG, "ignoring stale ring ${ring.callId} (${(System.currentTimeMillis() - ring.at) / 1000} s old)")
            return
        }
        if (!Push.firstTime(this, ring.callId)) {
            Log.i(TAG, "ignoring repeated ring ${ring.callId}")
            return
        }
        CallRegistry.ring(this, ring)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Log.w(TAG, "UnifiedPush registration failed: $reason")
    }

    override fun onUnregistered(instance: String) {
        Log.i(TAG, "UnifiedPush unregistered")
        Push.saveEndpoint(this, null)
    }

    private companion object {
        const val TAG = "YapPush"
    }
}
