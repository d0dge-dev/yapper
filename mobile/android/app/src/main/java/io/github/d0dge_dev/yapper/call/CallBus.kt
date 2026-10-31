package io.github.d0dge_dev.yapper.call

/**
 * Native → plugin events. The call and the ringing can outlive (or start before) the WebView and its plugin,
 * so nothing native holds the plugin; it subscribes here in load() and unsubscribes in handleOnDestroy().
 */
object CallBus {
    /** The call was ended natively (notification, headset, Telecom, GSM call): JS must end its side. */
    @Volatile var onHangup: (() -> Unit)? = null
    @Volatile var onRoutes: ((RouteState) -> Unit)? = null
    @Volatile var onEndpoint: ((String) -> Unit)? = null
    /** The ongoing call ended (any side). MainActivity drops "show when locked" then. */
    @Volatile var onCallEnded: (() -> Unit)? = null

    /** An answered callback the web app hasn't picked up yet (queued until a page subscribes). */
    @Volatile var pendingAnswer: Answer? = null

    data class Answer(val callId: String, val threadId: String, val at: Long = System.currentTimeMillis()) {
        fun fresh(now: Long = System.currentTimeMillis()) = now - at < ANSWER_TTL_MS
    }

    /** Takes the pending answer if it's still worth acting on. */
    fun takeAnswer(): Answer? = pendingAnswer.also { pendingAnswer = null }?.takeIf { it.fresh() }

    const val ANSWER_TTL_MS = 2 * 60 * 1000L
}
