package io.github.d0dge_dev.yapper.call

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebView
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import io.github.d0dge_dev.yapper.ring.Push
import org.json.JSONObject

/**
 * JS API (web/src/native.ts is the only caller):
 *   setup()                               page loaded: asks for notifications once, registers the PhoneAccount
 *                                         and UnifiedPush; resolves Status (+ `answer` if a callback was answered
 *                                         before the page was there)
 *   status()                              Status
 *   startCall({ title, audioRouting?, telecom?, volumeMirror? })   call started (mic open)
 *   endCall()                             call ended (no-op without one)
 *   getAudioRoutes() → Routes             setAudioRoute({ route })
 *   openSettings({ what: "fullScreenIntent" | "notifications" | "distributor" })
 * Events:
 *   hangup        the call was ended natively (notification, headset, Telecom, GSM call)
 *   audioRoute    Routes changed
 *   answer        { callId, threadId }: a callback was answered (also returned by setup() if it came earlier)
 *   pushEndpoint  { endpoint, device }: UnifiedPush endpoint (new or changed)
 * Status = { device, endpoint, distributor, distributors, notifications, fullScreenIntent, telecom }
 * Routes = { current: Route | null, available: Route[], names: { [Route]: string } }, Route = speaker|earpiece|bluetooth|wired
 *
 * Call startCall only after getUserMedia succeeded: Android 14+ only lets a microphone foreground
 * service start while the app is visible and holds RECORD_AUDIO.
 */
@CapacitorPlugin(
    name = "YapCall",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class YapCallPlugin : Plugin() {
    /** False once endCall ran, so a start that waited for the permission dialog doesn't revive a finished call. */
    @Volatile private var wanted = false
    /** The current page has run native.ts' setup(); reset when a new page starts loading. */
    @Volatile var pageReady = false
        private set
    private val main = Handler(Looper.getMainLooper())

    override fun load() {
        CallRegistry.init(context)
        CallBus.onHangup = { notifyListeners("hangup", JSObject()) }
        CallBus.onRoutes = { notifyListeners("audioRoute", it.toJs()) }
        CallBus.onEndpoint = { notifyListeners("pushEndpoint", JSObject().put("endpoint", it).put("device", Push.device)) }
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageStarted(webView: WebView?) {
                pageReady = false
            }
        })
    }

    /** The call lives in the WebView, which dies with the activity: don't leave it running. */
    override fun handleOnDestroy() {
        CallBus.onHangup = null
        CallBus.onRoutes = null
        CallBus.onEndpoint = null
        wanted = false
        CallRegistry.endCall()
    }

    // ------------------------------------------------------------------ setup / status

    @PluginMethod
    fun setup(call: PluginCall) {
        pageReady = true
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterSetupPermission")
            return
        }
        finishSetup(call)
    }

    @PermissionCallback
    private fun afterSetupPermission(call: PluginCall) = finishSetup(call)

    private fun finishSetup(call: PluginCall) {
        main.post {
            Notifications.ensureChannels(context)
            YapTelecom.ensureAccount(context)
            activity?.let { Push.register(it) }
            val status = status()
            CallBus.takeAnswer()?.let { status.put("answer", it.toJs()) }
            call.resolve(status)
        }
    }

    @PluginMethod
    fun status(call: PluginCall) = call.resolve(status())

    private fun status() = JSObject()
        .put("device", Push.device)
        .put("endpoint", Push.endpoint(context) ?: JSONObject.NULL)
        .put("distributor", Push.distributor(context) ?: JSONObject.NULL)
        .put("distributors", JSArray(Push.distributors(context)))
        .put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED)
        .put("fullScreenIntent", Notifications.canUseFullScreenIntent(context))
        .put("telecom", YapTelecom.ensureAccount(context))

    /** Delivers the pending answer to the page if it's listening. False: the page must be (re)loaded first. */
    fun flushAnswer(): Boolean {
        if (!pageReady || !hasListeners("answer")) return false
        val a = CallBus.takeAnswer() ?: return true
        notifyListeners("answer", a.toJs())
        return true
    }

    // ------------------------------------------------------------------ call

    @PluginMethod
    fun startCall(call: PluginCall) {
        wanted = true
        // Without POST_NOTIFICATIONS (Android 13+) the call still runs, but its notification (and the
        // hang-up button) is hidden. Ask once, then start either way.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission")
            return
        }
        start(call)
    }

    @PermissionCallback
    private fun afterNotificationPermission(call: PluginCall) = start(call)

    private fun start(call: PluginCall) {
        val title = call.getString("title")?.takeIf { it.isNotBlank() } ?: "Thread"
        val options = CallRegistry.Options(
            audioRouting = call.getBoolean("audioRouting", true) != false,
            telecom = call.getBoolean("telecom", true) != false,
            volumeMirror = call.getBoolean("volumeMirror", true) != false,
        )
        main.post {
            if (!wanted) return@post call.resolve()
            try {
                CallRegistry.startCall(context, title, options)
                call.resolve()
            } catch (e: Exception) {
                // e.g. ForegroundServiceStartNotAllowedException when called from the background
                CallRegistry.endCall()
                call.reject("Call service could not start: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun endCall(call: PluginCall) {
        wanted = false
        CallRegistry.endCall()
        call.resolve()
    }

    // ------------------------------------------------------------------ audio routes

    @PluginMethod
    fun getAudioRoutes(call: PluginCall) {
        main.post { call.resolve(CallRegistry.routes().toJs()) }
    }

    @PluginMethod
    fun setAudioRoute(call: PluginCall) {
        val route = Route.of(call.getString("route")) ?: return call.reject("unknown route")
        main.post {
            if (CallRegistry.selectRoute(route)) call.resolve(CallRegistry.routes().toJs())
            else call.reject("route not available: ${route.id}")
        }
    }

    // ------------------------------------------------------------------ settings

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val pkg = Uri.fromParts("package", context.packageName, null)
        val intent = when (call.getString("what")) {
            "fullScreenIntent" ->
                if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
                else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            "distributor" -> {
                main.post { activity?.let { Push.register(it, pick = true) } }
                return call.resolve()
            }
            else -> return call.reject("unknown settings page")
        }
        try {
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("settings page not available", e)
        }
    }
}

private fun RouteState.toJs(): JSObject {
    val names = JSObject()
    this.names.forEach { (r, n) -> names.put(r.id, n) }
    return JSObject()
        .put("current", current?.id ?: JSONObject.NULL)
        .put("available", JSArray(available.map { it.id }))
        .put("names", names)
}

private fun CallBus.Answer.toJs() = JSObject().put("callId", callId).put("threadId", threadId)
