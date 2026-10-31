package io.github.d0dge_dev.yapper.call

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.telecom.DisconnectCause
import android.util.Log
import io.github.d0dge_dev.yapper.MainActivity
import io.github.d0dge_dev.yapper.R
import io.github.d0dge_dev.yapper.ring.RingMessage

/**
 * All call state, on the main thread. Two halves:
 *
 * **Ongoing call** ([Session]): started by JS (YapCall.startCall, after getUserMedia). Runs [CallService]
 * (foreground service + CallStyle notification), [VolumeMirror], and a Telecom [YapConnection] that is either
 * placed now (outgoing) or the answered callback. If Telecom refuses or doesn't answer within
 * [TELECOM_WAIT_MS], the call runs without it and [CallAudio] does focus/mode/routing.
 *
 * **Rings** ([Ring]): a callback push → Telecom incoming call → incoming notification with full-screen intent →
 * answered / declined / missed after [RING_MS]. Without Telecom the same ring runs on the notification alone.
 */
@SuppressLint("StaticFieldLeak")
object CallRegistry {
    private const val TAG = "YapCallRegistry"
    const val RING_MS = 45_000L
    private const val TELECOM_WAIT_MS = 3_000L
    /** An answered callback the web app doesn't turn into a call within this time is hung up. */
    private const val CLAIM_MS = 60_000L

    private val main = Handler(Looper.getMainLooper())
    @SuppressLint("StaticFieldLeak") // the application context, not an activity
    private lateinit var app: Context

    fun init(context: Context) {
        if (!::app.isInitialized) app = context.applicationContext
    }

    private fun onMain(block: () -> Unit) = if (Looper.myLooper() == Looper.getMainLooper()) block() else { main.post(block); Unit }

    // ================================================================== ongoing call

    data class Options(val audioRouting: Boolean = true, val telecom: Boolean = true, val volumeMirror: Boolean = true)

    private class Session(val title: String, val options: Options) {
        var connection: YapConnection? = null
        var router: AudioRouter? = null
        var mirror: VolumeMirror? = null
        var waitingForTelecom = false
    }

    private var session: Session? = null
    /** The answered callback, until the web app starts its call (which then adopts it). */
    private var answered: YapConnection? = null
    private val claimTimeout = Runnable { answered?.let { Log.i(TAG, "answered callback never started, hanging up"); it.end(DisconnectCause.LOCAL) }; answered = null; CallBus.onCallEnded?.invoke() }

    val inCall get() = session != null

    /** Throws if the foreground service can't start (e.g. from the background on Android 14+). */
    fun startCall(context: Context, title: String, options: Options) {
        init(context)
        val s = session
        if (s != null) { // a second startCall (e.g. a reconnect) only renames the call
            CallService.start(app, title)
            return
        }
        CallService.start(app, title)
        val next = Session(title, options)
        session = next
        if (options.volumeMirror) next.mirror = VolumeMirror(app).also { it.start() }

        val pick = answered?.takeIf { !it.isEnded }
        answered = null
        main.removeCallbacks(claimTimeout)
        when {
            pick != null -> attach(next, pick)
            options.telecom && YapTelecom.placeCall(app, title, speaker = options.audioRouting) -> {
                next.waitingForTelecom = true
                main.postDelayed({ if (session === next && next.waitingForTelecom) withoutTelecom(next, "no connection from Telecom") }, TELECOM_WAIT_MS)
            }
            else -> withoutTelecom(next, if (options.telecom) "Telecom refused the call" else "Telecom off")
        }
    }

    private fun attach(s: Session, conn: YapConnection) {
        s.waitingForTelecom = false
        s.connection = conn
        s.router = conn
        conn.autoRoute = s.options.audioRouting
        conn.onRoutes = { CallBus.onRoutes?.invoke(it) }
        conn.setCallerDisplayName(app.getString(R.string.call_notification_title, s.title), android.telecom.TelecomManager.PRESENTATION_ALLOWED)
        if (conn.state != android.telecom.Connection.STATE_ACTIVE) conn.setActive()
        conn.applyAutoRoute()
        CallBus.onRoutes?.invoke(conn.routes)
    }

    private fun withoutTelecom(s: Session, why: String) {
        Log.i(TAG, "call without Telecom: $why")
        s.waitingForTelecom = false
        if (s.options.audioRouting) {
            s.router = CallAudio(app) { CallBus.onRoutes?.invoke(it) }.also { it.start() }
        }
    }

    /** Telecom accepted [YapTelecom.placeCall]. Null = nobody is waiting for it (too late), fail it. */
    fun outgoingCreated(context: Context, title: String?): YapConnection? {
        init(context)
        val s = session?.takeIf { it.waitingForTelecom } ?: return null
        val conn = YapConnection(null, app.getString(R.string.call_notification_title, title ?: s.title))
        attach(s, conn)
        return conn
    }

    fun outgoingFailed() = onMain {
        session?.takeIf { it.waitingForTelecom }?.let { withoutTelecom(it, "onCreateOutgoingConnectionFailed") }
    }

    /** JS ended the call (or the page went away). No-op without a call. */
    fun endCall() = onMain {
        val s = session ?: return@onMain
        session = null
        s.connection?.end(DisconnectCause.LOCAL)
        s.router?.stop()
        s.mirror?.stop()
        if (::app.isInitialized) app.stopService(Intent(app, CallService::class.java))
        CallBus.onRoutes?.invoke(RouteState.NONE)
        CallBus.onCallEnded?.invoke()
    }

    /** Ended outside JS (notification button, headset, Telecom/GSM, app swiped away): end it and tell JS. */
    fun hangupFromNative() = onMain {
        if (session == null) return@onMain
        endCall()
        CallBus.onHangup?.invoke()
    }

    fun routes(): RouteState = session?.router?.routes ?: RouteState.NONE

    fun selectRoute(route: Route): Boolean = session?.router?.select(route) ?: false

    // ================================================================== rings

    private class Ring(val msg: RingMessage) {
        var connection: YapConnection? = null
        var silenced = false
        var shown = false
        val timeout = Runnable { missed(msg.callId) }
    }

    private val rings = mutableMapOf<String, Ring>()
    /** Recently answered rings: a second answer path (Telecom + notification) for the same call finds it here. */
    private val answeredRings = LinkedHashMap<String, RingMessage>()
    /** Incoming-call screens to close when their ring ends. */
    val ringEndListeners = mutableSetOf<(String) -> Unit>()

    fun isRinging(callId: String) = rings.containsKey(callId)

    /** A callback push arrived (any thread). */
    fun ring(context: Context, msg: RingMessage) = onMain {
        init(context)
        if (rings.containsKey(msg.callId) || answeredRings.containsKey(msg.callId)) return@onMain
        if (session != null || answered != null) {
            // Already on a (yap) call: don't ring over it, leave a note instead.
            Notifications.showMissed(app, msg)
            return@onMain
        }
        val r = Ring(msg)
        rings[msg.callId] = r
        main.postDelayed(r.timeout, RING_MS)
        if (!YapTelecom.addIncoming(app, msg)) {
            show(r) // without Telecom: ring on the notification alone
        } else {
            // Telecom normally asks for the UI (onShowIncomingCallUi) or reports failure right away; never stay silent.
            main.postDelayed({ if (rings[msg.callId] === r && !r.shown) show(r) }, 2_000)
        }
    }

    fun incomingCreated(context: Context, msg: RingMessage): YapConnection? {
        init(context)
        val r = rings[msg.callId] ?: return null // timed out meanwhile
        val conn = YapConnection(msg.callId, app.getString(R.string.ring_caller))
        conn.setRinging()
        r.connection = conn
        return conn
    }

    fun incomingFailed(context: Context, msg: RingMessage) = onMain {
        init(context)
        rings[msg.callId]?.let { if (it.connection == null) show(it) }
    }

    fun showRing(conn: YapConnection) = onMain { rings[conn.callId]?.let { show(it) } }

    private fun show(r: Ring) {
        r.shown = true
        Notifications.showIncoming(app, r.msg, silent = r.silenced, timeoutMs = RING_MS + 5_000)
    }

    fun silence(conn: YapConnection) = onMain {
        val r = rings[conn.callId] ?: return@onMain
        if (r.silenced) return@onMain
        r.silenced = true
        show(r)
    }

    private fun finishRing(callId: String): Ring? {
        val r = rings.remove(callId) ?: return null
        main.removeCallbacks(r.timeout)
        Notifications.cancelIncoming(app, callId)
        ringEndListeners.toList().forEach { it(callId) }
        return r
    }

    /**
     * Answer [callId] (from the incoming screen, the notification or MainActivity). Returns the ring if it was
     * ringing or was answered a moment ago, null if it's gone (declined, missed, unknown).
     */
    fun answer(context: Context, callId: String): RingMessage? {
        init(context)
        answeredRings[callId]?.let { return it }
        val r = finishRing(callId) ?: return null
        remember(r.msg)
        r.connection?.let { conn ->
            conn.setActive()
            answered = conn
            main.removeCallbacks(claimTimeout)
            main.postDelayed(claimTimeout, CLAIM_MS)
        }
        return r.msg
    }

    /** Answered through Telecom (Bluetooth/car button): bring up the app on that thread. */
    fun answeredByTelecom(conn: YapConnection) = onMain {
        val id = conn.callId ?: return@onMain
        val msg = answer(app, id) ?: return@onMain
        try {
            app.startActivity(MainActivity.answerIntent(app, msg.callId, msg.threadId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "could not bring up the app after a headset answer", e)
        }
    }

    fun decline(context: Context, callId: String) = onMain {
        init(context)
        val r = finishRing(callId) ?: return@onMain
        r.connection?.end(DisconnectCause.REJECTED)
    }

    /** Another phone picked this ring up (server push `{type:"cancel"}`): stop ringing here, no missed-call notice. */
    fun answeredElsewhere(context: Context, callId: String) = onMain {
        init(context)
        val r = finishRing(callId) ?: return@onMain
        r.connection?.end(DisconnectCause.REMOTE)
        Log.i(TAG, "ring $callId answered on another device")
    }

    fun rejected(conn: YapConnection) = conn.callId?.let { decline(app, it) } ?: Unit

    private fun missed(callId: String) {
        val r = finishRing(callId) ?: return
        r.connection?.end(DisconnectCause.MISSED)
        Notifications.showMissed(app, r.msg)
    }

    /** Telecom ended a connection: a ringing one (caller side / system), the answered one, or the ongoing call. */
    fun disconnectedByTelecom(conn: YapConnection) = onMain {
        conn.callId?.let { id -> if (rings.containsKey(id)) { finishRing(id); conn.end(DisconnectCause.REMOTE); return@onMain } }
        if (answered === conn) {
            answered = null
            main.removeCallbacks(claimTimeout)
            conn.end(DisconnectCause.LOCAL)
            CallBus.onCallEnded?.invoke()
            return@onMain
        }
        if (session?.connection === conn) hangupFromNative() else conn.end(DisconnectCause.LOCAL)
    }

    private fun remember(msg: RingMessage) {
        answeredRings[msg.callId] = msg
        while (answeredRings.size > 20) answeredRings.remove(answeredRings.keys.first())
        main.postDelayed({ answeredRings.remove(msg.callId) }, CallBus.ANSWER_TTL_MS)
    }
}
