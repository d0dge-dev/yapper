package io.github.d0dge_dev.yapper.call

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Call audio without Telecom (fallback when the self-managed call can't be placed, or
 * `localStorage["yap.native.telecom"] = "off"`): transient audio focus (music pauses), MODE_IN_COMMUNICATION,
 * and the communication device. Starts on a headset if one is connected, else the loudspeaker; follows headsets
 * that come or go unless the user picked a route. Everything is undone in [stop].
 *
 * With Telecom, Telecom owns focus, mode and routing instead ([YapConnection]).
 */
class CallAudio(context: Context, private val onChange: (RouteState) -> Unit) : AudioRouter {
    private val am = context.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var focus: AudioFocusRequest? = null
    private var previousMode = AudioManager.MODE_NORMAL
    private var chosen: Route? = null
    private var started = false

    override var routes: RouteState = RouteState.NONE
        private set

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = route()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = route()
    }

    fun start() {
        if (started) return
        started = true
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener { }
            .build()
            .also { am.requestAudioFocus(it) }
        previousMode = am.mode
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        route()
        am.registerAudioDeviceCallback(devices, main)
    }

    override fun select(route: Route): Boolean {
        if (route !in available().keys) return false
        chosen = route
        route()
        return true
    }

    override fun stop() {
        if (!started) return
        started = false
        try {
            am.unregisterAudioDeviceCallback(devices)
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
            }
            am.mode = previousMode
            focus?.let { am.abandonAudioFocusRequest(it) }
            focus = null
        } catch (e: Exception) {
            Log.w(TAG, "audio restore failed", e)
        }
    }

    /** Route → the device to use for it (first matching type wins). */
    private fun available(): Map<Route, AudioDeviceInfo?> {
        if (Build.VERSION.SDK_INT >= 31) {
            val devs = am.availableCommunicationDevices
            return TYPES.mapNotNull { (route, types) ->
                types.firstNotNullOfOrNull { t -> devs.firstOrNull { it.type == t } }?.let { route to it }
            }.toMap()
        }
        // Before Android 12: speaker on/off only (earpiece, or a wired headset the system picks itself).
        return mapOf(Route.SPEAKER to null, Route.EARPIECE to null)
    }

    private fun route() {
        if (!started) return
        try {
            val avail = available()
            if (chosen != null && chosen !in avail.keys) chosen = null // e.g. the headset went away
            val pick = chosen ?: Routes.automatic(avail.keys) ?: return
            if (Build.VERSION.SDK_INT >= 31) {
                val dev = avail[pick] ?: return
                if (am.communicationDevice?.id != dev.id) {
                    am.setCommunicationDevice(dev)
                    Log.i(TAG, "communication device: ${pick.id} type=${dev.type} ${dev.productName}")
                }
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = pick == Route.SPEAKER
            }
            val names = avail.mapNotNull { (r, d) -> d?.productName?.toString()?.takeIf { r == Route.BLUETOOTH && it.isNotBlank() }?.let { r to it } }.toMap()
            val next = RouteState(pick, Routes.ORDER.filter { it in avail.keys }, names)
            if (next != routes) {
                routes = next
                onChange(next)
            }
        } catch (e: Exception) {
            Log.w(TAG, "audio routing failed", e)
        }
    }

    private companion object {
        const val TAG = "YapCallAudio"

        /** Only read on Android 12+ (see [available]); the BLE constants are inlined ints. */
        @SuppressLint("InlinedApi")
        val TYPES = listOf(
            Route.BLUETOOTH to listOf(AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_BLUETOOTH_SCO),
            Route.WIRED to listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES),
            Route.EARPIECE to listOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE),
            Route.SPEAKER to listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER),
        )
    }
}
