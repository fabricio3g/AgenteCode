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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.agente.android.R

/**
 * A labelled field: the label sits above the control (never floating inside it),
 * the frame is one hairline at the sharp input radius, and typing changes
 * nothing about the frame — the desktop's field, at a thumb's height.
 */
@Composable
fun AgenteField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    supporting: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    enabled: Boolean = true
) {
    val colors = AgenteTheme.colors
    val shape = RoundedCornerShape(AgenteTokens.Shape.inputRadius)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AgenteText(label, role = TextRole.Caption, color = colors.mutedForeground, weight = FontWeight.Medium)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .clip(shape)
                .border(1.dp, colors.ring, shape)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            contentAlignment = Alignment.CenterStart
        ) {
            if (value.isEmpty() && placeholder != null) {
                AgenteText(placeholder, role = TextRole.Base, color = colors.mutedForeground, maxLines = 1)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth(),
                enabled = enabled,
                textStyle = AgenteTheme.type.base.copy(color = colors.foreground),
                cursorBrush = SolidColor(colors.accent),
                singleLine = singleLine,
                minLines = minLines,
                maxLines = maxLines,
                visualTransformation = visualTransformation,
                keyboardOptions = keyboardOptions
            )
        }
        if (supporting != null) {
            AgenteText(supporting, role = TextRole.Caption, color = colors.mutedForeground)
        }
    }
}

/** Filtering a list: one quiet field with a leading glyph and a clear action. */
@Composable
fun AgenteSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier
) {
    val colors = AgenteTheme.colors
    val shape = RoundedCornerShape(AgenteTokens.Shape.rowRadius)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(shape)
            .background(colors.muted)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        AgenteIcon(R.drawable.agente_ic_search, null, size = AgenteMetrics.rowGlyph, tint = colors.mutedForeground)
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) {
                AgenteText(placeholder, role = TextRole.Small, color = colors.mutedForeground, maxLines = 1)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = AgenteTheme.type.small.copy(color = colors.foreground),
                cursorBrush = SolidColor(colors.accent),
                singleLine = true
            )
        }
        if (value.isNotEmpty()) {
            AgenteIconButton(
                icon = R.drawable.agente_ic_x,
                contentDescription = null,
                onClick = { onValueChange("") },
                size = 28.dp,
                glyph = 14.dp,
                tint = colors.mutedForeground
            )
        }
    }
}

/** A row of one-line copy in a settings sheet: label hard left, value hard right. */
@Composable
fun AgenteFormRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    valueColor: Color? = null
) {
    val colors = AgenteTheme.colors
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = AgenteMetrics.rowHeight)
            .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
            .then(
                if (onClick == null) Modifier
                else Modifier.clickable(interactionSource = interaction, indication = null, onClick = onClick)
            )
            .padding(horizontal = AgenteMetrics.rowInset),
        verticalAlignment = Alignment.CenterVertically
    ) {
        AgenteText(label, role = TextRole.Small, color = colors.secondary, modifier = Modifier.weight(1f), maxLines = 1)
        AgenteText(
            text = value,
            role = TextRole.Small,
            color = valueColor ?: colors.mutedForeground,
            maxLines = 1
        )
        if (onClick != null) {
            AgenteIcon(
                R.drawable.agente_ic_chevron_right,
                null,
                size = 14.dp,
                tint = colors.mutedForeground
            )
        }
    }
}
