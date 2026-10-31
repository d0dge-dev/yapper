package io.github.d0dge_dev.yapper.call

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import io.github.d0dge_dev.yapper.ring.RingMessage

/** Telecom's entry point for yap's self-managed calls. All state lives in [CallRegistry]; callbacks run on the main thread. */
class YapConnectionService : ConnectionService() {
    override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest): Connection {
        val title = request.extras?.getString(YapTelecom.EXTRA_TITLE)
        return CallRegistry.outgoingCreated(this, title)
            ?: Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
    }

    override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        CallRegistry.outgoingFailed()
    }

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest): Connection {
        val ring = request.ring()
        return ring?.let { CallRegistry.incomingCreated(this, it) }
            ?: Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
    }

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        // e.g. a GSM call that can't be put aside: ring without Telecom (notification only) or report it missed.
        request?.ring()?.let { CallRegistry.incomingFailed(this, it) }
    }

    private fun ConnectionRequest.ring(): RingMessage? {
        val x = extras ?: return null
        val callId = x.getString(YapTelecom.EXTRA_CALL_ID) ?: return null
        val threadId = x.getString(YapTelecom.EXTRA_THREAD_ID) ?: return null
        return RingMessage(callId, threadId, x.getString(YapTelecom.EXTRA_TITLE) ?: "Thread", x.getString(YapTelecom.EXTRA_REASON) ?: "done", x.getLong(YapTelecom.EXTRA_AT))
    }
}
