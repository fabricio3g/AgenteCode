package dev.agente.android.ui.design

import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.layout.size

/**
 * A lucide glyph, drawn from the vector drawable the generator produced from the
 * same package the desktop draws with. Stroke weight travels in the drawable, so
 * a glyph cannot read heavier here than it does there.
 */
@Composable
fun AgenteIcon(
    icon: Int,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = AgenteMetrics.glyph,
    tint: Color = AgenteTheme.colors.secondary
) {
    Image(
        painter = painterResource(icon),
        contentDescription = contentDescription,
        modifier = modifier.size(size),
        contentScale = ContentScale.Fit,
        colorFilter = ColorFilter.tint(tint)
    )
}
