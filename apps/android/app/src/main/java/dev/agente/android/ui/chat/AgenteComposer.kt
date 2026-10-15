package dev.agente.android.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.agente.android.R
import dev.agente.android.ui.design.AgenteChip
import dev.agente.android.ui.design.AgenteIcon
import dev.agente.android.ui.design.AgenteRunLine
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.AgenteTokens
import dev.agente.android.ui.design.TextRole

/**
 * The composer: one filled field with a large radius, the controls inside it —
 * model on the left, send (or stop) on the right. Nothing sits under it, because
 * a bar of tools under the field is what makes a phone look like a desktop.
 *
 * There is no attach glyph yet: the phone cannot send a file, and a button that
 * does nothing is worse than no button.
 */
@Composable
fun AgenteComposer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    modelLabel: String,
    onModelClick: () -> Unit,
    running: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = AgenteTheme.colors
    val shape = RoundedCornerShape(AgenteTokens.Shape.composerRadius)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.muted)
            .padding(start = 14.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box {
            if (draft.isEmpty()) {
                AgenteText(text = placeholder, role = TextRole.Prose, color = colors.mutedForeground)
            }
            BasicTextField(
                value = draft,
                onValueChange = onDraftChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = AgenteTheme.type.prose.copy(color = colors.foreground),
                cursorBrush = SolidColor(colors.accent),
                maxLines = 6
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgenteChip(
                label = modelLabel,
                onClick = onModelClick,
                trailingIcon = R.drawable.agente_ic_chevron_down,
                filled = true
            )
            Spacer(modifier = Modifier.weight(1f))
            SendButton(running = running, enabled = running || draft.isNotBlank(), onSend = onSend, onStop = onStop)
        }
    }
}

/** Ready: the page's ink in a circle. Working: the same circle, holding a stop. */
@Composable
private fun SendButton(running: Boolean, enabled: Boolean, onSend: () -> Unit, onStop: () -> Unit) {
    val colors = AgenteTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val fill = if (enabled) colors.foreground else colors.muted.copy(alpha = 0.6f)
    Box(
        modifier = Modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(fill)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled
            ) { if (running) onStop() else onSend() },
        contentAlignment = Alignment.Center
    ) {
        AgenteIcon(
            icon = if (running) R.drawable.agente_ic_square else R.drawable.agente_ic_arrow_up,
            contentDescription = stringResource(if (running) R.string.composer_stop else R.string.composer_send),
            size = 20.dp,
            tint = if (enabled) colors.canvas else colors.mutedForeground
        )
    }
}

/** What the run is doing, above the composer: our meter, not a spinner. */
@Composable
fun ComposerStatusRow(label: String, modifier: Modifier = Modifier) {
    AgenteRunLine(label = label, modifier = modifier, busy = true)
}
