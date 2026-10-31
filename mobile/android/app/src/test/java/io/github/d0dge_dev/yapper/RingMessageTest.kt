package io.github.d0dge_dev.yapper

import io.github.d0dge_dev.yapper.ring.RingMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RingMessageTest {
    private val now = 1_800_000_000_000L
    private fun body(at: Long = now, extra: String = "") =
        """{"type":"ring","callId":"c1","threadId":"t/1 ä","title":"Fix the build","reason":"approval","at":$at$extra}"""

    @Test fun parsesTheServerPayload() {
        val r = RingMessage.parse(body())!!
        assertEquals(RingMessage("c1", "t/1 ä", "Fix the build", "approval", now), r)
        assertEquals("braucht eine Freigabe", r.reasonText)
    }

    @Test fun rejectsOtherMessages() {
        assertNull(RingMessage.parse("""{"type":"other","callId":"c1","threadId":"t","at":1}"""))
        assertNull(RingMessage.parse("""{"type":"ring","threadId":"t","at":1}"""))
        assertNull(RingMessage.parse("""{"type":"ring","callId":"c1","threadId":"t"}"""))
        assertNull(RingMessage.parse("not json"))
        assertNull(RingMessage.parse(""))
    }

    @Test fun defaultsForMissingTitleAndReason() {
        val r = RingMessage.parse("""{"type":"ring","callId":"c","threadId":"t","at":5}""")!!
        assertEquals("Thread", r.title)
        assertEquals("ist fertig", r.reasonText)
    }

    @Test fun ringsOlderThan90sAreStale() {
        assertTrue(RingMessage.parse(body(at = now - 90_000))!!.fresh(now))
        assertFalse(RingMessage.parse(body(at = now - 90_001))!!.fresh(now))
        assertTrue(RingMessage.parse(body(at = now + 5_000))!!.fresh(now)) // server clock a bit ahead
    }
}
