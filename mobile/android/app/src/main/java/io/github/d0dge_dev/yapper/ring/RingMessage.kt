package io.github.d0dge_dev.yapper.ring

import org.json.JSONObject

/**
 * A callback ring pushed by the server (server/callbacks.ts) through UnifiedPush, as a raw JSON body:
 * `{ "type": "ring", "callId", "threadId", "title", "reason": "done"|"approval"|"question"|"failed", "at": epoch ms }`.
 * When one phone answers, the server pushes `{ "type": "cancel", "callId" }` to all of them.
 */
data class RingMessage(
    val callId: String,
    val threadId: String,
    val title: String,
    val reason: String,
    val at: Long,
) {
    /** Rings older than [MAX_AGE_MS] are dropped (delivered late, e.g. after the phone was offline). */
    fun fresh(now: Long = System.currentTimeMillis()) = now - at <= MAX_AGE_MS

    /** "yap <does what>", for the incoming-call screen and notifications. */
    val reasonText: String
        get() = when (reason) {
            "approval" -> "braucht eine Freigabe"
            "question" -> "hat eine Frage"
            "failed" -> "ist fehlgeschlagen"
            else -> "ist fertig"
        }

    companion object {
        const val MAX_AGE_MS = 90_000L

        /** The callId of a `{ "type": "cancel", "callId" }` push (answered on another device), else null. */
        fun parseCancel(body: String): String? = try {
            val o = JSONObject(body)
            o.optString("callId").takeIf { o.optString("type") == "cancel" && it.isNotBlank() }
        } catch (_: Exception) {
            null
        }

        /** Null for anything that isn't a well-formed ring. */
        fun parse(body: String): RingMessage? = try {
            val o = JSONObject(body)
            val callId = o.optString("callId")
            val threadId = o.optString("threadId")
            val at = o.optLong("at", 0L)
            if (o.optString("type") != "ring" || callId.isBlank() || threadId.isBlank() || at <= 0L) {
                null
            } else {
                RingMessage(callId, threadId, o.optString("title").ifBlank { "Thread" }, o.optString("reason", "done"), at)
            }
        } catch (_: Exception) {
            null
        }
    }
}
