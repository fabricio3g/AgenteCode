package dev.agente.android.ui.design

import androidx.compose.ui.graphics.Color
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

/**
 * OKLCH to sRGB, so a hue that identifies a kind of thing can be written the way
 * the desktop writes it (`oklch(0.72 0.11 280)`) instead of being eyeballed into
 * a hex value that drifts. Used for the starter glyphs, whose hue is identity —
 * never emphasis.
 *
 * The matrices are Björn Ottosson's published OKLab definition; out-of-gamut
 * results are clamped per channel, which is what a browser does when it paints
 * an sRGB screenshot of the same colour.
 */
fun oklch(lightness: Float, chroma: Float, hueDegrees: Float): Color {
    val radians = hueDegrees * (Math.PI / 180.0)
    val a = chroma * cos(radians).toFloat()
    val b = chroma * sin(radians).toFloat()

    val l = (lightness + 0.3963377774f * a + 0.2158037573f * b).toDouble().pow(3.0)
    val m = (lightness - 0.1055613458f * a - 0.0638541728f * b).toDouble().pow(3.0)
    val s = (lightness - 0.0894841775f * a - 1.2914855480f * b).toDouble().pow(3.0)

    val red = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    val green = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    val blue = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    return Color(gamma(red), gamma(green), gamma(blue))
}

private fun gamma(channel: Double): Float {
    val encoded = if (channel <= 0.0031308) 12.92 * channel else 1.055 * channel.pow(1.0 / 2.4) - 0.055
    return encoded.coerceIn(0.0, 1.0).toFloat()
}

/**
 * A starter's glyph colour: the muted hue in dark, the deeper one in light —
 * exactly the pair `ComposerSuggestions` paints on the desktop.
 */
fun starterInk(hueDegrees: Float, dark: Boolean): Color =
    if (dark) oklch(0.72f, 0.11f, hueDegrees) else oklch(0.5f, 0.12f, hueDegrees)
