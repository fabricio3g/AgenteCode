package dev.agente.android.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** One glyph action. Muted until pressed, never a ring, never a ripple: the
 *  desktop's rail buttons, at a thumb's size. */
@Composable
fun AgenteIconButton(
    icon: Int,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color = AgenteTheme.colors.secondary,
    size: Dp = AgenteMetrics.iconButton,
    glyph: Dp = AgenteMetrics.glyph
) {
    val colors = AgenteTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
            .background(if (pressed && enabled) colors.rowHover else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        AgenteIcon(
            icon = icon,
            contentDescription = contentDescription,
            size = glyph,
            tint = if (enabled) tint else colors.mutedForeground.copy(alpha = 0.45f)
        )
    }
}

enum class AgenteButtonVariant {
    /** The one confirmation on a screen: the page's ink, inverted. */
    Solid,

    /** Everything else. */
    Outline,

    /** A quiet action inside a row of copy. */
    Plain
}

/** The desktop's button recipe (`--radius-sm`, 13sp medium) at 40dp tall. */
@Composable
fun AgenteButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: AgenteButtonVariant = AgenteButtonVariant.Outline,
    enabled: Boolean = true,
    leadingIcon: Int? = null
) {
    val colors = AgenteTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(AgenteTokens.Shape.inputRadius)
    val fill = when (variant) {
        AgenteButtonVariant.Solid -> colors.foreground
        AgenteButtonVariant.Outline -> if (pressed) colors.rowHover else Color.Transparent
        AgenteButtonVariant.Plain -> if (pressed) colors.rowHover else Color.Transparent
    }
    val ink = when (variant) {
        AgenteButtonVariant.Solid -> colors.canvas
        AgenteButtonVariant.Outline -> colors.foreground
        AgenteButtonVariant.Plain -> colors.secondary
    }
    Row(
        modifier = modifier
            .height(40.dp)
            .clip(shape)
            .background(fill)
            .then(if (variant == AgenteButtonVariant.Outline) Modifier.border(1.dp, colors.line, shape) else Modifier)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (leadingIcon != null) {
            AgenteIcon(leadingIcon, null, size = AgenteMetrics.rowGlyph, tint = ink.copy(alpha = if (enabled) 1f else 0.45f))
        }
        AgenteText(
            text = label,
            role = TextRole.Small,
            color = ink.copy(alpha = if (enabled) 1f else 0.45f),
            weight = FontWeight.Medium,
            maxLines = 1
        )
    }
}

/** A secondary action beside send: a pill, 12sp, dim. `filled` is the
 *  composer's own pill — a raised fill instead of a hairline, so the model reads
 *  as a value you can change rather than as another outlined button. */
@Composable
fun AgenteChip(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: Int? = null,
    trailingIcon: Int? = null,
    tint: Color? = null,
    filled: Boolean = false
) {
    val colors = AgenteTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(AgenteTokens.Shape.rowRadius)
    val ink = tint ?: if (filled) colors.secondary else colors.mutedForeground
    Row(
        modifier = modifier
            .height(32.dp)
            .clip(shape)
            .background(
                when {
                    pressed -> colors.rowHover
                    filled -> if (AgenteTheme.isDark) lerp(colors.muted, colors.foreground, 0.10f) else colors.card
                    else -> Color.Transparent
                }
            )
            .then(if (filled) Modifier else Modifier.border(1.dp, colors.lineSubtle, shape))
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (leadingIcon != null) AgenteIcon(leadingIcon, null, size = 14.dp, tint = ink)
        AgenteText(label, role = TextRole.Caption, color = ink, weight = FontWeight.Medium, maxLines = 1)
        if (trailingIcon != null) AgenteIcon(trailingIcon, null, size = 14.dp, tint = ink.copy(alpha = 0.7f))
    }
}

/** Two or three mutually exclusive views of the same thing: a raised pill on a
 *  quiet track. The raised segment is lighter than the track in both themes — in
 *  dark, `canvas` would read as pressed in rather than raised. */
@Composable
fun AgenteSegmentedControl(
    options: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    stretch: Boolean = false
) {
    val colors = AgenteTheme.colors
    val dark = AgenteTheme.isDark
    val shape = RoundedCornerShape(AgenteTokens.Shape.rowRadius)
    val raised = if (dark) lerp(colors.muted, colors.foreground, 0.15f) else colors.canvas
    Row(
        modifier = modifier
            .clip(shape)
            .background(colors.muted)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        options.forEachIndexed { index, option ->
            val selected = index == selectedIndex
            val interaction = remember { MutableInteractionSource() }
            val pressed by interaction.collectIsPressedAsState()
            Box(
                modifier = Modifier
                    .then(if (stretch) Modifier.weight(1f) else Modifier)
                    .clip(RoundedCornerShape(7.dp))
                    .background(
                        when {
                            selected -> raised
                            pressed -> colors.rowHover
                            else -> Color.Transparent
                        }
                    )
                    .clickable(interactionSource = interaction, indication = null) { onSelect(index) }
                    .padding(horizontal = if (stretch) 0.dp else 12.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center
            ) {
                AgenteText(
                    text = option,
                    role = TextRole.Caption,
                    color = if (selected) colors.foreground else colors.mutedForeground,
                    weight = if (selected) FontWeight.Medium else FontWeight.Normal,
                    maxLines = 1
                )
            }
        }
    }
}

/** A count or a state as a small dim mark beside a label. */
@Composable
fun AgenteBadge(label: String, modifier: Modifier = Modifier, tint: Color? = null) {
    val colors = AgenteTheme.colors
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(colors.muted)
            .padding(horizontal = 6.dp, vertical = 2.dp)
    ) {
        AgenteText(label, role = TextRole.Caption, color = tint ?: colors.mutedForeground, maxLines = 1)
    }
}

/** A full-width divider between blocks, dimmer than a hairline. */
@Composable
fun AgenteSeparator(modifier: Modifier = Modifier, inset: Dp = AgenteMetrics.gutter) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(1.dp)
            .background(AgenteTheme.colors.lineSubtle)
    )
}
