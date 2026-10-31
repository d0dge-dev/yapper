package io.github.d0dge_dev.yapper.call

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.graphics.Color
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import io.github.d0dge_dev.yapper.MainActivity
import io.github.d0dge_dev.yapper.R
import io.github.d0dge_dev.yapper.ring.RingMessage

/**
 * The incoming-callback screen, opened by the ringing notification's full-screen intent (over the lock
 * screen, screen turned on). Decline just dismisses; answer hands over to [MainActivity], which opens the
 * thread and tells the web app to start the call. Closes itself when the ring ends elsewhere.
 */
class IncomingCallActivity : AppCompatActivity() {
    companion object {
        private const val EXTRA_RING = "ring" // callId, threadId, title, reason, at

        fun intent(context: Context, ring: RingMessage): Intent = Intent(context, IncomingCallActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
            .putExtra(EXTRA_RING, arrayOf(ring.callId, ring.threadId, ring.title, ring.reason, ring.at.toString()))
    }

    private var ring: RingMessage? = null
    private val animations = mutableListOf<android.animation.Animator>()
    private val onRingEnded: (String) -> Unit = { id -> if (id == ring?.callId) finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        setContentView(R.layout.activity_incoming_call)
        pulse(findViewById(R.id.pulse1), 0L)
        pulse(findViewById(R.id.pulse2), 900L)
        nudge(findViewById(R.id.answer))
        CallRegistry.ringEndListeners += onRingEnded
        bind(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        bind(intent)
    }

    private fun bind(intent: Intent) {
        val a = intent.getStringArrayExtra(EXTRA_RING)
        val r = a?.takeIf { it.size == 5 }?.let { RingMessage(it[0], it[1], it[2], it[3], it[4].toLongOrNull() ?: 0L) }
        if (r == null || !CallRegistry.isRinging(r.callId)) return finish()
        ring = r
        findViewById<TextView>(R.id.title).text = r.title
        findViewById<TextView>(R.id.reason).text = r.reasonText
        findViewById<ImageButton>(R.id.decline).setOnClickListener {
            CallRegistry.decline(this, r.callId)
            finish()
        }
        findViewById<ImageButton>(R.id.answer).setOnClickListener {
            startActivity(MainActivity.answerIntent(this, r.callId, r.threadId))
            finish()
        }
    }

    /** A ring that grows out of the logo and fades, over and over. */
    private fun pulse(view: View, delay: Long) {
        fun anim(prop: String, vararg v: Float) = ObjectAnimator.ofFloat(view, prop, *v).apply {
            duration = 1800
            repeatCount = ValueAnimator.INFINITE
            interpolator = DecelerateInterpolator()
        }
        view.alpha = 0f
        AnimatorSet().apply {
            playTogether(anim("scaleX", 1f, 1.65f), anim("scaleY", 1f, 1.65f), anim("alpha", 0.9f, 0f))
            startDelay = delay
            start()
        }.also { animations += it }
    }

    /** The answer button bobs a little, like a phone's. */
    private fun nudge(view: View) {
        ObjectAnimator.ofFloat(view, "translationY", 0f, -10f).apply {
            duration = 650
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            start()
        }.also { animations += it }
    }

    override fun onDestroy() {
        animations.forEach { it.cancel() }
        CallRegistry.ringEndListeners -= onRingEnded
        super.onDestroy()
    }
}
