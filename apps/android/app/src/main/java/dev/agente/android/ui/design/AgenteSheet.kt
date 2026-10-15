package dev.agente.android.ui.design

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agente.android.R
import dev.agente.android.ui.design.AgenteScrim

/** * A floating panel on the panel plane: no border, no drag handle, no Material
 * chrome. It arrives with the `dialog` step of the ladder over a scrim and
 * leaves on the faster exit curve; Back closes it, and the scrim is the only
 * thing that dims what is behind.
 *
 * Actions in [footer] start on the content's left edge — the desktop's rule for
 * every modal footer, which is why the footer is not right-aligned.
 */
@Composable
fun AgenteSheet(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    fullHeight: Boolean = false,
    footer: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val colors = AgenteTheme.colors
    val motion = AgenteTheme.motion
    val visible = remember { MutableTransitionState(false).apply { targetState = true } }
    val shape = RoundedCornerShape(
        topStart = AgenteTokens.Shape.cardRadius,
        topEnd = AgenteTokens.Shape.cardRadius
    )

    BackHandler(enabled = true) { onDismiss() }

    Box(modifier = modifier.fillMaxSize()) {
        AnimatedVisibility(
            visibleState = visible,
            enter = fadeIn(motion.spec(AgenteTokens.Motion.dialog)),
            exit = fadeOut(motion.spec(AgenteTokens.Motion.fast, entering = false))
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(AgenteScrim)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onDismiss
                    )
            )
        }
        AnimatedVisibility(
            visibleState = visible,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = slideInVertically(motion.spec(AgenteTokens.Motion.dialog)) { height -> height } +
                fadeIn(motion.spec(AgenteTokens.Motion.normal)),
            exit = slideOutVertically(motion.spec(AgenteTokens.Motion.normal, entering = false)) { height -> height } +
                fadeOut(motion.spec(AgenteTokens.Motion.fast, entering = false))
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (fullHeight) Modifier.fillMaxHeight() else Modifier)
                    .clip(shape)
                    .background(colors.panel)
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    .imePadding()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .padding(start = AgenteMetrics.gutter, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    AgenteText(
                        text = title,
                        role = TextRole.Base,
                        color = colors.foreground,
                        weight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                        maxLines = 1
                    )
                    AgenteIconButton(
                        icon = R.drawable.agente_ic_x,
                        contentDescription = null,
                        onClick = onDismiss,
                        tint = colors.mutedForeground
                    )
                }
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(
                            if (fullHeight) Modifier.weight(1f)
                            else Modifier.heightIn(max = 520.dp)
                        )
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = AgenteMetrics.gutter, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    content = content
                )
                if (footer != null) {
                    Box(modifier = Modifier.padding(horizontal = AgenteMetrics.gutter, vertical = 12.dp)) { footer() }
                }
            }
        }
    }
}
