package io.github.d0dge_dev.yapper

import io.github.d0dge_dev.yapper.call.Route
import io.github.d0dge_dev.yapper.call.Routes
import io.github.d0dge_dev.yapper.call.VolumeMirror
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoutesTest {
    @Test fun cyclesThroughAvailableRoutesInOrder() {
        val all = listOf(Route.WIRED, Route.SPEAKER, Route.BLUETOOTH, Route.EARPIECE)
        assertEquals(Route.EARPIECE, Routes.next(Route.SPEAKER, all))
        assertEquals(Route.BLUETOOTH, Routes.next(Route.EARPIECE, all))
        assertEquals(Route.SPEAKER, Routes.next(Route.WIRED, all))
        assertEquals(Route.SPEAKER, Routes.next(Route.EARPIECE, listOf(Route.SPEAKER, Route.EARPIECE)))
        assertEquals(Route.SPEAKER, Routes.next(null, listOf(Route.EARPIECE, Route.SPEAKER)))
        assertNull(Routes.next(Route.SPEAKER, emptyList()))
    }

    @Test fun automaticPrefersHeadsetThenSpeaker() {
        assertEquals(Route.BLUETOOTH, Routes.automatic(listOf(Route.SPEAKER, Route.EARPIECE, Route.BLUETOOTH)))
        assertEquals(Route.WIRED, Routes.automatic(listOf(Route.SPEAKER, Route.WIRED)))
        assertEquals(Route.SPEAKER, Routes.automatic(listOf(Route.EARPIECE, Route.SPEAKER)))
        assertEquals(Route.EARPIECE, Routes.automatic(listOf(Route.EARPIECE)))
    }

    @Test fun routeIdsMatchTheWebContract() {
        assertEquals(listOf("speaker", "earpiece", "bluetooth", "wired"), Routes.ORDER.map { it.id })
        assertEquals(Route.BLUETOOTH, Route.of("bluetooth"))
        assertNull(Route.of("car"))
    }

    @Test fun volumeMirrorKeepsTheFraction() {
        assertEquals(0, VolumeMirror.mirrorIndex(0, 7, 25))
        assertEquals(25, VolumeMirror.mirrorIndex(7, 7, 25))
        assertEquals(4, VolumeMirror.mirrorIndex(1, 7, 25))
        assertEquals(13, VolumeMirror.mirrorIndex(5, 10, 25))
        assertEquals(25, VolumeMirror.mirrorIndex(99, 7, 25)) // clamped
        assertEquals(0, VolumeMirror.mirrorIndex(3, 0, 25))
    }
}
