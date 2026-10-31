package io.github.d0dge_dev.yapper.call

/** Where call audio goes. `id` is what JS sees (web/src/native.ts → AudioRoute). */
enum class Route(val id: String) {
    SPEAKER("speaker"),
    EARPIECE("earpiece"),
    BLUETOOTH("bluetooth"),
    WIRED("wired");

    companion object {
        fun of(id: String?): Route? = entries.firstOrNull { it.id == id }
    }
}

/** `names`: device names where known (e.g. the Bluetooth headset's), keyed by route. */
data class RouteState(
    val current: Route?,
    val available: List<Route>,
    val names: Map<Route, String> = emptyMap(),
) {
    companion object {
        val NONE = RouteState(null, emptyList())
    }
}

/** Chooses the call's audio route: via Telecom ([YapConnection]) or, without Telecom, via AudioManager ([CallAudio]). */
interface AudioRouter {
    val routes: RouteState
    /** False if the route isn't available right now. */
    fun select(route: Route): Boolean
    fun stop()
}

object Routes {
    /** Display/cycle order. A headset beats the speaker as the automatic choice. */
    val ORDER = listOf(Route.SPEAKER, Route.EARPIECE, Route.BLUETOOTH, Route.WIRED)

    /** The route after [current] among [available], in [ORDER], wrapping around. */
    fun next(current: Route?, available: Collection<Route>): Route? {
        val sorted = ORDER.filter { it in available }
        if (sorted.isEmpty()) return null
        val i = sorted.indexOf(current)
        return sorted[(i + 1) % sorted.size]
    }

    /** What a call starts on: a headset if one is connected, else the loudspeaker (you look at the screen). */
    fun automatic(available: Collection<Route>): Route? = when {
        Route.BLUETOOTH in available -> Route.BLUETOOTH
        Route.WIRED in available -> Route.WIRED
        Route.SPEAKER in available -> Route.SPEAKER
        else -> available.firstOrNull()
    }
}
