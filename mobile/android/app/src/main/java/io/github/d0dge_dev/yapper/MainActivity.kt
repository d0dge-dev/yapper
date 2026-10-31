package io.github.d0dge_dev.yapper

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity
import io.github.d0dge_dev.yapper.call.CallBus
import io.github.d0dge_dev.yapper.call.CallRegistry
import io.github.d0dge_dev.yapper.call.YapCallPlugin
import io.github.d0dge_dev.yapper.call.YapTelecom
import org.json.JSONObject

/**
 * Hosts the Yapper server (capacitor.config.ts → server.url, set from YAPPER_SERVER_URL) in a WebView with the Capacitor bridge.
 *
 * Native features live in [YapCallPlugin] (package `call`: ongoing call, Telecom, audio routes, callback rings)
 * and package `ring` (UnifiedPush). This activity also takes two intents from notifications:
 *  - [ACTION_ANSWER]       a callback was answered: open its thread, hand the web app an `answer` event, and show
 *                          over the lock screen until that call ends
 *  - [ACTION_OPEN_THREAD]  "Verpasster Rückruf" tapped: open the thread
 */
class MainActivity : BridgeActivity() {
    companion object {
        const val ACTION_ANSWER = "io.github.d0dge_dev.yapper.ANSWER"
        const val ACTION_OPEN_THREAD = "io.github.d0dge_dev.yapper.OPEN_THREAD"

        fun answerIntent(context: Context, callId: String, threadId: String): Intent =
            Intent(context, MainActivity::class.java)
                .setAction(ACTION_ANSWER)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(YapTelecom.EXTRA_CALL_ID, callId)
                .putExtra(YapTelecom.EXTRA_THREAD_ID, threadId)

        fun openThreadIntent(context: Context, threadId: String): Intent =
            Intent(context, MainActivity::class.java)
                .setAction(ACTION_OPEN_THREAD)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(YapTelecom.EXTRA_THREAD_ID, threadId)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(YapCallPlugin::class.java) // must happen before super.onCreate builds the bridge
        super.onCreate(savedInstanceState)
        CallRegistry.init(this)
        val webView = bridge?.webView ?: return

        // Mic only, and only for the yap origin.
        webView.webChromeClient = YapChromeClient(bridge)
        // Keep the renderer as important as the app while it is hidden; the call service keeps the app itself alive.
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        // Back: in-app history (thread → list) first, otherwise go to the background instead of finishing
        // the activity, so a running call survives the back gesture.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val history = webView.copyBackForwardList()
                val prev = if (history.currentIndex > 0) history.getItemAtIndex(history.currentIndex - 1) else null
                if (prev != null && Uri.parse(prev.url).host == yapHost()) webView.goBack() else moveTaskToBack(true)
            }
        })

        CallBus.onCallEnded = { runOnUiThread { showOverLockScreen(false) } }
        if (savedInstanceState == null) handleCallIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleCallIntent(intent)
    }

    override fun onDestroy() {
        CallBus.onCallEnded = null
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        // Persist the SSO session cookie now rather than whenever WebView gets round to it.
        CookieManager.getInstance().flush()
    }

    private fun handleCallIntent(intent: Intent?) {
        val threadId = intent?.getStringExtra(YapTelecom.EXTRA_THREAD_ID) ?: return
        when (intent.action) {
            ACTION_ANSWER -> {
                val callId = intent.getStringExtra(YapTelecom.EXTRA_CALL_ID) ?: return
                intent.action = null // a recreated activity must not answer again
                val ring = CallRegistry.answer(this, callId)
                if (ring == null) {
                    openThread(threadId) // rang out or declined meanwhile: just show the thread
                    return
                }
                showOverLockScreen(true)
                CallBus.pendingAnswer = CallBus.Answer(ring.callId, ring.threadId)
                // A page that is up and listening gets the event and opens the thread itself (navigating here would
                // race with its popstate handler). Otherwise load the thread; native.ts picks the answer up in setup().
                if (plugin()?.flushAnswer() != true) bridge?.webView?.loadUrl(threadUrl(threadId))
            }
            ACTION_OPEN_THREAD -> {
                intent.action = null
                if (!CallRegistry.inCall) openThread(threadId)
            }
        }
    }

    /** Shows [threadId]: a fresh page load, since the web app reads the hash only when it boots. */
    private fun openThread(threadId: String) {
        val webView = bridge?.webView ?: return
        val url = threadUrl(threadId)
        if (plugin()?.pageReady == true) {
            webView.evaluateJavascript("location.replace(${JSONObject.quote(url)}); location.reload();", null)
        } else {
            webView.loadUrl(url)
        }
    }

    private fun threadUrl(threadId: String): String {
        val base = (bridge?.serverUrl ?: "").substringBefore('#').let { if (it.endsWith("/")) it else "$it/" }
        return base + "#" + Uri.encode(threadId) // = encodeURIComponent
    }

    /** While an answered callback runs, the call screen may show over the keyguard (like a phone app). */
    private fun showOverLockScreen(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on)
            setTurnScreenOn(on)
        } else {
            @Suppress("DEPRECATION")
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (on) window.addFlags(flags) else window.clearFlags(flags)
        }
    }

    private fun plugin(): YapCallPlugin? = bridge?.getPlugin("YapCall")?.instance as? YapCallPlugin

    private fun yapHost(): String? = bridge?.serverUrl?.let { Uri.parse(it).host }
}
