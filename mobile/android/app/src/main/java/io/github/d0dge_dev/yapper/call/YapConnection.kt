package io.github.d0dge_dev.yapper.call

import android.os.Build
import android.os.OutcomeReceiver
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.CallEndpointException
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.TelecomManager
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.concurrent.Executor

/**
 * One yap call in Telecom: outgoing (started in the app) or incoming (a callback ring, [callId] set).
 * No CAPABILITY_HOLD: when you answer a GSM call, Telecom disconnects this one ([onDisconnect]) and the
 * web app hangs up, instead of leaving a half-alive call with an open mic.
 *
 * Audio routing goes through Telecom ([AudioRouter]): call endpoints on Android 14+, CallAudioState before.
 */
class YapConnection(val callId: String?, displayName: String) : Connection(), AudioRouter {
    private var ended = false
    /** Called when the route state changes (set by [CallRegistry] while this is the ongoing call). */
    var onRoutes: ((RouteState) -> Unit)? = null
    /** Automatic routing (speaker unless a headset is there); false = leave it to Telecom. */
    var autoRoute = true
    private var chosen: Route? = null

    override var routes: RouteState = RouteState.NONE
        private set
    private var endpoints: List<Any> = emptyList() // CallEndpoint on 34+, kept untyped so older APIs don't load the class

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        setAddress(YapTelecom.address, TelecomManager.PRESENTATION_ALLOWED)
        setCallerDisplayName(displayName, TelecomManager.PRESENTATION_ALLOWED)
    }

    val isEnded get() = ended

    fun end(cause: Int) {
        if (ended) return
        ended = true
        onRoutes = null
        setDisconnected(DisconnectCause(cause))
        destroy()
    }

    // ---- Telecom → yap

    override fun onShowIncomingCallUi() = CallRegistry.showRing(this)
    override fun onAnswer(videoState: Int) = CallRegistry.answeredByTelecom(this)
    override fun onReject() = CallRegistry.rejected(this)
    override fun onDisconnect() = CallRegistry.disconnectedByTelecom(this)
    override fun onAbort() = CallRegistry.disconnectedByTelecom(this)
    override fun onSilence() = CallRegistry.silence(this)

    @Deprecated("Replaced by call endpoints on Android 14+")
    override fun onCallAudioStateChanged(audio: CallAudioState) {
        if (Build.VERSION.SDK_INT >= 34) return // endpoints callbacks carry the same, with names
        val mask = audio.supportedRouteMask
        val avail = LEGACY.filter { (_, bit) -> mask and bit != 0 }.map { it.first }
        update(LEGACY.firstOrNull { it.second == audio.route }?.first, avail, emptyMap())
    }

    @RequiresApi(34)
    override fun onAvailableCallEndpointsChanged(available: List<CallEndpoint>) {
        endpoints = available
        updateFromEndpoints(current = routes.current)
    }

    @RequiresApi(34)
    override fun onCallEndpointChanged(endpoint: CallEndpoint) {
        updateFromEndpoints(current = routeOf(endpoint.endpointType))
    }

    @RequiresApi(34)
    private fun updateFromEndpoints(current: Route?) {
        @Suppress("UNCHECKED_CAST")
        val eps = endpoints as List<CallEndpoint>
        val avail = eps.mapNotNull { routeOf(it.endpointType) }.distinct()
        val names = eps.filter { it.endpointType == CallEndpoint.TYPE_BLUETOOTH }.associate { Route.BLUETOOTH to it.endpointName.toString() }
        update(current, avail, names)
    }

    private fun update(current: Route?, available: List<Route>, names: Map<Route, String>) {
        val next = RouteState(current, Routes.ORDER.filter { it in available }, names)
        if (chosen != null && chosen !in next.available) chosen = null
        val changed = next != routes
        routes = next
        if (changed) onRoutes?.invoke(next)
        correct()
    }

    /**
     * Telecom starts audio calls on the earpiece and falls back to it when a headset goes away. yap is a
     * look-at-the-screen call, so move to the speaker then, unless the earpiece was picked on purpose.
     */
    private fun correct() {
        if (!autoRoute || ended || getState() != STATE_ACTIVE || chosen == Route.EARPIECE) return
        if (routes.current == Route.EARPIECE && Route.SPEAKER in routes.available &&
            Route.BLUETOOTH !in routes.available && Route.WIRED !in routes.available
        ) {
            request(Route.SPEAKER)
        }
    }

    // ---- yap → Telecom

    override fun select(route: Route): Boolean {
        if (route !in routes.available) return false
        chosen = route
        return request(route)
    }

    override fun stop() {
        onRoutes = null
    }

    /** Re-applies the automatic choice, e.g. once an answered callback becomes the ongoing call. */
    fun applyAutoRoute() = correct()

    private fun request(route: Route): Boolean {
        if (route == routes.current) return true
        return try {
            if (Build.VERSION.SDK_INT >= 34) requestEndpoint(route)
            else {
                @Suppress("DEPRECATION")
                setAudioRoute(LEGACY.first { it.first == route }.second)
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "route change to ${route.id} failed", e)
            false
        }
    }

    @RequiresApi(34)
    private fun requestEndpoint(route: Route): Boolean {
        @Suppress("UNCHECKED_CAST")
        val ep = (endpoints as List<CallEndpoint>).firstOrNull { routeOf(it.endpointType) == route } ?: return false
        requestCallEndpointChange(ep, DIRECT, object : OutcomeReceiver<Void, CallEndpointException> {
            override fun onResult(result: Void?) {}
            override fun onError(error: CallEndpointException) {
                Log.w(TAG, "endpoint change to ${route.id} failed: ${error.code}")
            }
        })
        return true
    }

    private companion object {
        const val TAG = "YapConnection"
        val DIRECT = Executor { it.run() }

        @Suppress("DEPRECATION")
        val LEGACY = listOf(
            Route.SPEAKER to CallAudioState.ROUTE_SPEAKER,
            Route.EARPIECE to CallAudioState.ROUTE_EARPIECE,
            Route.BLUETOOTH to CallAudioState.ROUTE_BLUETOOTH,
            Route.WIRED to CallAudioState.ROUTE_WIRED_HEADSET,
        )

        @RequiresApi(34)
        fun routeOf(type: Int): Route? = when (type) {
            CallEndpoint.TYPE_SPEAKER -> Route.SPEAKER
            CallEndpoint.TYPE_EARPIECE -> Route.EARPIECE
            CallEndpoint.TYPE_BLUETOOTH -> Route.BLUETOOTH
            CallEndpoint.TYPE_WIRED_HEADSET -> Route.WIRED
            else -> null // streaming
        }
    }
}
