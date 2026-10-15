package dev.agente.android.ui.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties

/** One action in an [AgenteMenu]. */
data class MenuAction(
    val label: String,
    val icon: Int? = null,
    val destructive: Boolean = false,
    val onSelect: () -> Unit
)

/**
 * The app's popup menu: a floating panel on the panel plane, one row per action,
 * no Material elevation and no dividers — the desktop's menu, sized for a thumb.
 * It dismisses on a tap outside or on Back, and it is the phone's answer to the
 * desktop's hover action bar.
 */
@Composable
fun AgenteMenu(
    actions: List<MenuAction>,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = 208.dp
) {
    val colors = AgenteTheme.colors
    Popup(
        onDismissRequest = onDismiss,
        offset = IntOffset(0, 0),
        properties = PopupProperties(focusable = true)
    ) {
        Column(
            modifier = modifier
                .width(width)
                .clip(RoundedCornerShape(AgenteTokens.Shape.cardRadius))
                .background(colors.panel)
                .border(1.dp, colors.line, RoundedCornerShape(AgenteTokens.Shape.cardRadius))
                .padding(vertical = 4.dp)
        ) {
            actions.forEach { action ->
                val interaction = remember { MutableInteractionSource() }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = AgenteMetrics.rowHeight)
                        .clickable(interactionSource = interaction, indication = null) {
                            onDismiss()
                            action.onSelect()
                        }
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    if (action.icon != null) {
                        AgenteIcon(
                            action.icon,
                            null,
                            size = AgenteMetrics.rowGlyph,
                            tint = if (action.destructive) colors.accentStrong else colors.mutedForeground
                        )
                    } else {
                        Box(Modifier.width(AgenteMetrics.rowGlyph))
                    }
                    AgenteText(
                        text = action.label,
                        role = TextRole.Small,
                        color = if (action.destructive) colors.accentStrong else colors.foreground,
                        maxLines = 1
                    )
                }
            }
        }
    }
}

/** An inline notice above the composer: quiet, dismissible, never a dialog. */
@Composable
fun AgenteNotice(text: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val colors = AgenteTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
            .background(colors.muted)
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        AgenteIcon(
            dev.agente.android.R.drawable.agente_ic_circle_alert,
            null,
            size = AgenteMetrics.rowGlyph,
            tint = colors.accentStrong
        )
        AgenteText(
            text = text,
            role = TextRole.Caption,
            color = colors.secondary,
            modifier = Modifier.weight(1f),
            maxLines = 3
        )
        AgenteIconButton(
            icon = dev.agente.android.R.drawable.agente_ic_x,
            contentDescription = null,
            onClick = onDismiss,
            size = 36.dp,
            glyph = 14.dp,
            tint = colors.mutedForeground
        )
    }
}

/** An empty state: the words, then one honest hint. Never a card. */
@Composable
fun AgenteEmptyState(
    title: String,
    hint: String? = null,
    modifier: Modifier = Modifier,
    color: Color = AgenteTheme.colors.mutedForeground
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = AgenteMetrics.gutter, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        AgenteText(title, role = TextRole.Small, color = color)
        if (hint != null) AgenteText(hint, role = TextRole.Caption, color = AgenteTheme.colors.mutedForeground)
    }
}
