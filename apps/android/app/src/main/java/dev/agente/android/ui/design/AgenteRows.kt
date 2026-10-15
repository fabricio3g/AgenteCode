package dev.agente.android.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The sidebar's one row recipe — one height, one radius, one press fill, one
 * current state — which every list in the app uses: conversations, characters,
 * models, settings values.
 */
@Composable
fun AgenteRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null
) {
    val colors = AgenteTheme.colors
    val shape = RoundedCornerShape(AgenteTokens.Shape.rowRadius)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = AgenteMetrics.rowHeight)
            .clip(shape)
            .background(
                when {
                    selected -> colors.activePlane
                    pressed -> colors.rowHover
                    else -> Color.Transparent
                }
            )
            .then(if (selected) Modifier.border(1.dp, colors.lineSubtle, shape) else Modifier)
            .then(
                if (onClick == null) Modifier
                else Modifier.clickable(interactionSource = interaction, indication = null, onClick = onClick)
            )
            .padding(horizontal = AgenteMetrics.rowInset, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AgenteTokens.Geometry.rowGap)
    ) {
        leading?.invoke()
        Column(modifier = Modifier.weight(1f)) {
            AgenteText(
                text = title,
                role = TextRole.Small,
                color = if (selected) colors.foreground else colors.secondary,
                weight = if (selected) FontWeight.Medium else FontWeight.Normal,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (subtitle != null) {
                AgenteText(
                    text = subtitle,
                    role = TextRole.Caption,
                    color = colors.mutedForeground,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
        trailing?.invoke()
    }
}

/** A dim group heading above a run of rows, with an optional action hard right. */
@Composable
fun AgenteSectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(36.dp)
            .padding(start = AgenteMetrics.gutter, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        AgenteText(
            text = text,
            role = TextRole.Caption,
            color = AgenteTheme.colors.mutedForeground,
            weight = FontWeight.Medium,
            modifier = Modifier.weight(1f),
            maxLines = 1
        )
        trailing?.invoke()
    }
}

/** A small square of identity: a character's initial, never a photo frame. */
@Composable
fun AgenteAvatar(label: String, modifier: Modifier = Modifier, size: Dp = 36.dp) {
    val colors = AgenteTheme.colors
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
            .background(colors.muted),
        contentAlignment = Alignment.Center
    ) {
        AgenteText(
            text = label.take(1).uppercase(),
            role = TextRole.Small,
            color = colors.mutedForeground,
            weight = FontWeight.Medium
        )
    }
}

/** The mark that says "this is the one in effect" — the desktop's `◈`. */
@Composable
fun AgenteCurrentMark(modifier: Modifier = Modifier) {
    Box(modifier = modifier.width(18.dp), contentAlignment = Alignment.Center) {
        AgenteText("\u25C8", role = TextRole.Caption, color = AgenteTheme.colors.accent, maxLines = 1)
    }
}

/** One entry in a picker: a row, a dim header, or both in a list. */
data class PickerEntry(
    val id: String,
    val label: String,
    val detail: String? = null,
    val header: Boolean = false,
    val current: Boolean = false
)

/**
 * The one list look: dim group headers, rows that press, and `◈` on the item in
 * effect. Filtering happens above this (see [AgenteSearchField]).
 */
@Composable
fun AgentePickerList(
    entries: List<PickerEntry>,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier) {
        entries.forEach { entry ->
            if (entry.header) {
                AgenteSectionLabel(entry.label)
            } else {
                AgenteRow(
                    title = entry.label,
                    subtitle = entry.detail,
                    selected = entry.current,
                    onClick = { onPick(entry.id) },
                    trailing = if (entry.current) ({ AgenteCurrentMark() }) else null
                )
            }
        }
    }
}
