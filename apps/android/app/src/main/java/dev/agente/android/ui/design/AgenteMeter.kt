package dev.agente.android.ui.design

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.hypot
import kotlin.math.max

/** How alive a run is. `attention` (an approval waiting) lands with remote Code. */
enum class MeterMode { Busy, Quiet, Stopped }

/**
 * The tile meter: two columns of tiles a drop steps through, drawn in the same
 * mosaic as the landing field — six levels, hard steps, no fades.
 *
 * `busy` drops a cell every 0.31s, `quiet` the same rain at a quarter speed so a
 * stalled run looks stalled, `stopped` holds the still frame while the engine
 * unwinds. Under reduced motion the still frame is all there is.
 */
@Composable
fun TileMeter(mode: MeterMode, modifier: Modifier = Modifier, cell: Dp = 4.dp) {
    val colors = AgenteTheme.colors
    val motion = AgenteTheme.motion
    val running = mode != MeterMode.Stopped && !motion.reduceMotion
    val step = if (mode == MeterMode.Busy) 310f else 1250f

    // One clock for the meter; when it is not running its value is ignored
    // rather than skipped, so the composition keeps the same shape.
    val transition = rememberInfiniteTransition(label = "tile-meter")
    val clock by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween((step * 5f).toInt(), easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "meter-clock"
    )

    Canvas(modifier = modifier.size(cell * 2, cell * 4)) {
        val cellPx = cell.toPx()
        val tile = cellPx * 0.8f
        val inset = (cellPx - tile) / 2f
        val peak = if (mode == MeterMode.Busy) 1f else 0.62f
        val levels = floatArrayOf(0f, 0.39f, 0.53f, 1f)
        val mixes = floatArrayOf(0f, 0.05f, 0.22f, 1f)

        PHASES.forEachIndexed { index, phase ->
            val level = when {
                !running -> if (index == 2 || index == 7) 3 else 0
                else -> {
                    var local = (clock * 5f - phase) % 5f
                    if (local < 0f) local += 5f
                    when {
                        local < 2f -> 0
                        local < 3f -> 1
                        local < 4f -> 2
                        else -> 3
                    }
                }
            }
            if (level == 0) return@forEachIndexed
            drawRoundRect(
                color = lerp(colors.tileAccent, colors.tileHighlight, mixes[level]).copy(alpha = peak * levels[level]),
                topLeft = Offset((index / 4) * cellPx + inset, (index % 4) * cellPx + inset),
                size = Size(tile, tile),
                cornerRadius = CornerRadius(tile * AgenteTokens.tileRadius)
            )
        }
    }
}

/**
 * Phases are the tiles' delays in cell-crossing units: the cycle minus how long
 * the drop takes to reach that cell. The two columns never fall in lockstep.
 */
private val PHASES = floatArrayOf(-3.8f, -6.3f, -2.8f, -5.3f, -1.8f, -4.3f, -0.8f, -3.3f)

private class MosaicTile(val live: Boolean, val duration: Float, val delay: Float, val level: Float, val still: Boolean)

/**
 * The desktop's scatter, same seed and same call order, so the phone's field is
 * the same picture: about a third of the cells ever light, each on its own clock.
 */
private fun scatter(count: Int): List<MosaicTile> {
    var seed = 7L
    fun random(): Float {
        seed = (seed * 16807L) % 2147483647L
        return (seed - 1) / 2147483646f
    }
    return List(count) {
        val live = random() < 0.42f
        val duration = 4f + random() * 6f
        val delay = -random() * 10f
        val level = if (random() < 0.25f) 1f else 0.55f
        val still = live && random() < 0.3f
        MosaicTile(live, duration, delay, level, still)
    }
}

/**
 * The landing mosaic behind the greeting: a sparse twinkle under a mask that
 * keeps the middle quiet and fades the field out at its edges. Decorative, so it
 * stays out of the accessibility tree; under reduced motion it holds a still
 * scatter. One clock drives every cell, which is why the field costs one
 * animation rather than a hundred.
 */
@Composable
fun GreetingTiles(modifier: Modifier = Modifier, columns: Int = 20, rows: Int = 5) {
    val colors = AgenteTheme.colors
    val motion = AgenteTheme.motion
    val tiles = remember(columns, rows) { scatter(columns * rows) }
    val transition = rememberInfiniteTransition(label = "greeting-tiles")
    val clock by transition.animateFloat(
        initialValue = 0f,
        targetValue = 60f,
        animationSpec = infiniteRepeatable(tween(60_000, easing = LinearEasing), RepeatMode.Restart),
        label = "tile-clock"
    )
    val seconds = if (motion.reduceMotion) 0f else clock
    val cell = AgenteMetrics.tileCell

    Canvas(modifier = modifier.size(cell * columns, cell * rows)) {
        val cellPx = cell.toPx()
        val tile = cellPx * 0.6f
        val inset = (cellPx - tile) / 2f
        val radius = tile * AgenteTokens.tileRadius
        val ink = lerp(colors.tileAccent, colors.tileHighlight, 0.85f)
        val centre = Offset(size.width / 2f, size.height / 2f)
        val reach = max(size.width, size.height) / 2f

        tiles.forEachIndexed { index, tileSpec ->
            val column = index % columns
            val row = index / columns
            val alpha = when {
                !tileSpec.live -> 0f
                motion.reduceMotion -> if (tileSpec.still) tileSpec.level * 0.45f else 0f
                else -> {
                    val phase = (((seconds + tileSpec.delay) % tileSpec.duration) + tileSpec.duration) % tileSpec.duration / tileSpec.duration
                    when {
                        phase < 0.6f -> 0f
                        phase < 0.72f -> tileSpec.level * 0.4f
                        phase < 0.88f -> tileSpec.level * 0.8f
                        else -> tileSpec.level * 0.35f
                    }
                }
            }
            if (alpha <= 0f) return@forEachIndexed
            val centreX = column * cellPx + inset + tile / 2f
            val centreY = row * cellPx + inset + tile / 2f
            val distance = hypot(centreX - centre.x, centreY - centre.y) / reach
            val mask = when {
                distance < 0.2f -> 0.25f
                distance < 0.55f -> 0.25f + (distance - 0.2f) / 0.35f * 0.75f
                distance < 1f -> 1f - (distance - 0.55f) / 0.45f
                else -> 0f
            }
            if (mask <= 0f) return@forEachIndexed
            drawRoundRect(
                color = ink.copy(alpha = alpha * mask),
                topLeft = Offset(column * cellPx + inset, row * cellPx + inset),
                size = Size(tile, tile),
                cornerRadius = CornerRadius(radius)
            )
        }
    }
}
