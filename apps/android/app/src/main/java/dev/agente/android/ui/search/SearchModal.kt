package dev.agente.android.ui.search

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.Space
import dev.agente.android.data.SearchHit
import dev.agente.android.ui.design.AgenteEmptyState
import dev.agente.android.ui.design.AgenteIcon
import dev.agente.android.ui.design.AgenteIconButton
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteRow
import dev.agente.android.ui.design.AgenteScrim
import dev.agente.android.ui.design.AgenteSectionLabel
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.AgenteTokens
import dev.agente.android.ui.design.TextRole
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * Search, the way the desktop does it: a modal over the page — field, then the
 * results with the line that matched — rather than a filter living inside a
 * list. It opens focused, closes on the scrim, on its own glyph or on Back, and
 * an empty query lists recent conversations instead of nothing.
 */
@Composable
fun SearchModal(model: AgenteViewModel) {
    val colors = AgenteTheme.colors
    val motion = AgenteTheme.motion
    val visible = remember { MutableTransitionState(false).apply { targetState = true } }
    val focus = remember { FocusRequester() }
    val shape = RoundedCornerShape(AgenteTokens.Shape.cardRadius)

    BackHandler(enabled = true) { model.closeSearch() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    Box(modifier = Modifier.fillMaxSize()) {
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
                        onClick = model::closeSearch
                    )
            )
        }
        AnimatedVisibility(
            visibleState = visible,
            modifier = Modifier.align(Alignment.TopCenter),
            enter = slideInVertically(motion.spec(AgenteTokens.Motion.dialog)) { height -> -height / 4 } +
                fadeIn(motion.spec(AgenteTokens.Motion.normal)),
            exit = slideOutVertically(motion.spec(AgenteTokens.Motion.normal, entering = false)) { height -> -height / 4 } +
                fadeOut(motion.spec(AgenteTokens.Motion.fast, entering = false))
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.statusBars)
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .heightIn(max = 560.dp)
                    .clip(shape)
                    .background(colors.panel)
                    .border(1.dp, colors.line, shape)
                    .imePadding()
            ) {
                SearchField(model = model, focus = focus)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(colors.lineSubtle)
                )
                Results(model)
            }
        }
    }
}

@Composable
private fun SearchField(model: AgenteViewModel, focus: FocusRequester) {
    val colors = AgenteTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .padding(start = AgenteMetrics.gutter, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        AgenteIcon(
            icon = R.drawable.agente_ic_search,
            contentDescription = null,
            size = AgenteMetrics.rowGlyph,
            tint = colors.mutedForeground
        )
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (model.searchQuery.isEmpty()) {
                AgenteText(
                    text = stringResource(
                        if (model.space == Space.Code) R.string.search_placeholder_code
                        else R.string.search_placeholder
                    ),
                    role = TextRole.Small,
                    color = colors.mutedForeground,
                    maxLines = 1
                )
            }
            BasicTextField(
                value = model.searchQuery,
                onValueChange = model::search,
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                textStyle = AgenteTheme.type.small.copy(color = colors.foreground),
                cursorBrush = SolidColor(colors.accent),
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search)
            )
        }
        if (model.searchQuery.isNotEmpty()) {
            AgenteText(
                text = pluralStringResource(R.plurals.search_count, model.searchHits.size, model.searchHits.size),
                role = TextRole.Caption,
                color = colors.mutedForeground,
                maxLines = 1
            )
        }
        AgenteIconButton(
            icon = R.drawable.agente_ic_x,
            contentDescription = stringResource(R.string.search_clear),
            onClick = {
                if (model.searchQuery.isEmpty()) model.closeSearch() else model.search("")
            },
            tint = colors.mutedForeground
        )
    }
}

@Composable
private fun Results(model: AgenteViewModel) {
    val query = model.searchQuery
    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(vertical = 6.dp)
    ) {
        item(key = "new") {
            AgenteRow(
                title = stringResource(R.string.history_new_chat),
                onClick = {
                    model.newChat()
                    model.closeSearch()
                },
                leading = {
                    AgenteIcon(
                        icon = R.drawable.agente_ic_plus,
                        contentDescription = null,
                        size = AgenteMetrics.rowGlyph,
                        tint = AgenteTheme.colors.mutedForeground
                    )
                },
                modifier = Modifier.padding(horizontal = 6.dp)
            )
        }
        if (model.searchHits.isEmpty()) {
            item(key = "empty") {
                AgenteEmptyState(
                    title = stringResource(if (query.isBlank()) R.string.search_empty else R.string.search_no_matches),
                    hint = stringResource(if (query.isBlank()) R.string.search_empty_hint else R.string.search_no_matches_hint)
                )
            }
        } else {
            item(key = "label") {
                AgenteSectionLabel(
                    stringResource(if (query.isBlank()) R.string.search_recent else R.string.search_matches)
                )
            }
            items(model.searchHits, key = { it.chat.id }) { hit ->
                HitRow(hit, model)
            }
        }
    }
}

@Composable
private fun HitRow(hit: SearchHit, model: AgenteViewModel) {
    val colors = AgenteTheme.colors
    AgenteRow(
        title = hit.chat.title,
        subtitle = hit.snippet ?: spaceLabel(hit.chat.space),
        selected = hit.chat.id == model.activeChat?.id,
        onClick = {
            model.openChat(hit.chat)
            model.closeSearch()
        },
        trailing = {
            val days = daysAgo(hit.chat.updatedAt)
            if (days > 0) {
                AgenteText(
                    text = stringResource(R.string.search_days_ago).replace("{n}", days.toString()),
                    role = TextRole.Caption,
                    color = colors.mutedForeground,
                    maxLines = 1
                )
            }
        },
        modifier = Modifier.padding(horizontal = 6.dp)
    )
}

@Composable
private fun spaceLabel(wire: String): String =
    stringResource(Space.entries.firstOrNull { it.wire == wire }?.labelRes ?: R.string.space_home)

/** Whole days since the conversation moved, which is all a row shows. */
private fun daysAgo(updatedAt: Long): Long {
    val zone = ZoneId.systemDefault()
    val day = Instant.ofEpochMilli(updatedAt).atZone(zone).toLocalDate()
    return ChronoUnit.DAYS.between(day, LocalDate.now(zone))
}
