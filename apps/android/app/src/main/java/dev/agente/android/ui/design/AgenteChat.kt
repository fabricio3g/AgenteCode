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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.agente.android.R

/**
 * Your own turn: a filled bubble, right-aligned, never wider than most of the
 * column. The answer beside it is plain prose — a bubble around both would make
 * the thread two columns of boxes instead of a conversation.
 */
@Composable
fun AgenteUserBubble(text: String, modifier: Modifier = Modifier) {
    val colors = AgenteTheme.colors
    Row(modifier = modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(AgenteMetrics.bubbleRadius))
                .background(colors.muted)
                .padding(horizontal = 14.dp, vertical = 10.dp)
        ) {
            AgenteText(text = text, role = TextRole.Prose)
        }
    }
}

/**
 * Reasoning, folded: one dim line above the answer, opened only if the reader
 * asks. It is the model's working, not the deliverable, so it never lands in the
 * answer by default.
 */
@Composable
fun AgenteThoughtRow(thinking: String, modifier: Modifier = Modifier) {
    val colors = AgenteTheme.colors
    var open by remember { mutableStateOf(false) }
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null
                ) { open = !open }
                .padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            AgenteIcon(
                icon = if (open) R.drawable.agente_ic_chevron_down else R.drawable.agente_ic_chevron_right,
                contentDescription = null,
                size = 14.dp,
                tint = colors.mutedForeground
            )
            AgenteText(
                text = stringResource(R.string.thread_thinking),
                role = TextRole.Caption,
                color = colors.mutedForeground,
                maxLines = 1
            )
        }
        if (open) {
            AgenteText(
                text = thinking,
                role = TextRole.Small,
                color = colors.secondary,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
                    .background(colors.muted)
                    .padding(12.dp)
            )
        }
    }
}

/** A glyph action under an answer: dim, 32dp of target around a 16dp drawing. */
@Composable
fun AgenteGlyphButton(
    icon: Int,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color? = null,
    size: Dp = 32.dp
) {
    val colors = AgenteTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
            .background(if (pressed) colors.rowHover else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        AgenteIcon(icon, contentDescription, size = 16.dp, tint = tint ?: colors.mutedForeground)
    }
}

/** The one floating control: back to the newest line of the thread. */
@Composable
fun AgenteJumpToLatest(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = AgenteTheme.colors
    val shape = CircleShape
    Box(
        modifier = modifier
            .size(38.dp)
            .clip(shape)
            .background(colors.card)
            .border(1.dp, colors.line, shape)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick
            ),
        contentAlignment = Alignment.Center
    ) {
        AgenteIcon(
            icon = R.drawable.agente_ic_chevron_down,
            contentDescription = stringResource(R.string.thread_jump_to_latest),
            size = 18.dp,
            tint = colors.secondary
        )
    }
}

/**
 * One starter on the landing: a glyph in the kind's hue and what it does, on a
 * hairline card. Two by two, because a phone reads four of these at a glance.
 */
@Composable
fun AgenteSuggestionCard(
    label: String,
    icon: Int,
    hue: Float,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = AgenteTheme.colors
    val dark = AgenteTheme.isDark
    val shape = RoundedCornerShape(AgenteTokens.Shape.cardRadius)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Column(
        modifier = modifier
            .heightIn(min = 74.dp)
            .clip(shape)
            .background(if (pressed) colors.rowHover else Color.Transparent)
            .border(1.dp, colors.line, shape)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(12.dp),
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        AgenteIcon(icon, null, size = 18.dp, tint = starterInk(hue, dark))
        AgenteText(
            text = label,
            role = TextRole.Small,
            color = colors.secondary,
            weight = FontWeight.Medium,
            maxLines = 2
        )
    }
}

/** The tile meter beside a run's label: what the app is doing, in our own marks. */
@Composable
fun AgenteRunLine(label: String, modifier: Modifier = Modifier, busy: Boolean = true) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        TileMeter(if (busy) MeterMode.Busy else MeterMode.Quiet)
        AgenteText(text = label, role = TextRole.Small, color = AgenteTheme.colors.mutedForeground, maxLines = 1)
    }
}
