package io.github.d0dge_dev.yapper.call

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.util.Log
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

/**
 * Makes the volume keys change what you hear during a call, also with the screen locked.
 *
 * In a call Android is in communication mode, so the volume keys (hardware, lock screen, Bluetooth) always
 * adjust the voice-call stream. The WebView, though, decides per output stream at creation time whether it
 * plays as voice or as media (Chromium's AudioManagerAndroid: VOICE_COMMUNICATION only for streams opened
 * after its first echo-cancelled capture stream, and never for reused idle streams), so yap's speech often
 * ends up on the media stream, which the keys don't touch. The app can't choose that usage for the WebView.
 *
 * So while a call runs, every change of the voice-call volume is mirrored onto the media volume (same
 * fraction of the range). Whichever stream the WebView plays on, it follows the keys, and the volume panel
 * shows the call slider, as in a phone call. The media volume is put back when the call ends.
 */
class VolumeMirror(private val context: Context) {
    private val am = context.getSystemService(AudioManager::class.java)
    private var savedMusic = -1
    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val stream = intent.getIntExtra(EXTRA_STREAM, -1)
            if (stream == AudioManager.STREAM_VOICE_CALL || stream == STREAM_BLUETOOTH_SCO) sync(stream)
        }
    }

    fun start() {
        if (registered) return
        try {
            savedMusic = am.getStreamVolume(AudioManager.STREAM_MUSIC)
            ContextCompat.registerReceiver(context, receiver, IntentFilter(VOLUME_CHANGED_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
            registered = true
            sync(AudioManager.STREAM_VOICE_CALL)
        } catch (e: Exception) {
            Log.w(TAG, "volume mirror failed to start", e)
        }
    }

    fun stop() {
        if (!registered) return
        registered = false
        try {
            context.unregisterReceiver(receiver)
            if (savedMusic >= 0) am.setStreamVolume(AudioManager.STREAM_MUSIC, savedMusic, 0)
        } catch (e: Exception) {
            Log.w(TAG, "volume mirror restore failed", e)
        }
        savedMusic = -1
    }

    private fun sync(stream: Int) {
        try {
            val music = mirrorIndex(am.getStreamVolume(stream), am.getStreamMaxVolume(stream), am.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
            if (music != am.getStreamVolume(AudioManager.STREAM_MUSIC)) am.setStreamVolume(AudioManager.STREAM_MUSIC, music, 0)
        } catch (e: Exception) {
            // SecurityException under some DND policies; the call goes on with whatever volume it has.
            Log.w(TAG, "volume mirror failed", e)
        }
    }

    companion object {
        private const val TAG = "YapVolumeMirror"
        // Hidden in the SDK but stable since Android 4 (Media3's StreamVolumeManager listens to it too).
        const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
        const val EXTRA_STREAM = "android.media.EXTRA_VOLUME_STREAM_TYPE"
        const val STREAM_BLUETOOTH_SCO = 6

        /** Call-volume index → media-volume index with the same fraction of the range. */
        fun mirrorIndex(voice: Int, voiceMax: Int, musicMax: Int): Int {
            if (voiceMax <= 0 || musicMax <= 0) return 0
            return (voice.coerceIn(0, voiceMax).toDouble() * musicMax / voiceMax).roundToInt().coerceIn(0, musicMax)
        }
    }
}
