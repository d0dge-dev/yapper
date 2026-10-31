package io.github.d0dge_dev.yapper

import android.net.Uri
import android.webkit.PermissionRequest
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebChromeClient

/**
 * Capacitor's chrome client grants any capture request from any page once the runtime permission is there.
 * yap only needs the microphone, and only the Yapper server (capacitor.config.ts → server.url) may have it
 * (not the SSO login page, not anything a link might load). Everything else is denied; the RECORD_AUDIO runtime prompt is still
 * handled by the base class.
 */
class YapChromeClient(private val bridge: Bridge) : BridgeWebChromeClient(bridge) {
    override fun onPermissionRequest(request: PermissionRequest) {
        val yap = bridge.serverUrl?.let { Uri.parse(it) }
        val origin = request.origin
        val fromYap = yap != null && origin.scheme == yap.scheme && origin.host == yap.host && origin.port == yap.port
        val audioOnly = request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
        if (fromYap && audioOnly) super.onPermissionRequest(request) else request.deny()
    }
}
