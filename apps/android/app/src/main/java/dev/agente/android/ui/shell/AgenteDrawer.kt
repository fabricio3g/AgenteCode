package dev.agente.android.ui.shell

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.Space
import dev.agente.android.data.Conversation
import dev.agente.android.ui.design.AgenteEmptyState
import dev.agente.android.ui.design.AgenteIcon
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteRow
import dev.agente.android.ui.design.AgenteScrim
import dev.agente.android.ui.design.AgenteSectionLabel
import dev.agente.android.ui.design.AgenteSegmentedControl
import dev.agente.android.ui.design.AgenteSeparator
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.AgenteTokens
import dev.agente.android.ui.design.TextRole
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToInt

/**
 * The drawer: the desktop's activity rail and sidebar in one plane, because a
 * phone has room for one. Spaces first as a selector, then starting a
 * conversation, then the conversations themselves, with settings pinned to the
 * bottom where the rail keeps its gear.
 *
 * The scrim covers the whole page — app bar included, or the bar reads as a
 * lighter band above the dimmed page — while the panel starts below the bar so
 * the hamburger stays the way out. It arrives on the `smooth` step, leaves on the
 * faster exit curve, and closes on a swipe, on the scrim or on Back.
 */
@Composable
fun AgenteDrawer(model: AgenteViewModel, open: Boolean, onClose: () -> Unit) {
    val colors = AgenteTheme.colors
    val motion = AgenteTheme.motion
    val scope = rememberCoroutineScope()
    val width = 320.dp
    val widthPx = with(LocalDensity.current) { width.toPx() }
    val offset = remember { Animatable(-widthPx) }

    LaunchedEffect(open, widthPx) {
        if (open) offset.animateTo(0f, motion.spec(AgenteTokens.Motion.smooth))
        else offset.animateTo(-widthPx, motion.spec(AgenteTokens.Motion.normal, entering = false))
    }

    // Composed while it is on screen or on its way off it, and not a frame
    // longer: the check is derived so a drag does not recompose the list.
    val rendered by remember { derivedStateOf { open || offset.value > -widthPx } }
    if (!rendered) return

    BackHandler(enabled = true) { onClose() }

    Box(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer { alpha = (1f + offset.value / widthPx).coerceIn(0f, 1f) }
                .background(AgenteScrim)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onClose
                )
        )
        Column(
            modifier = Modifier
                .width(width)
                .fillMaxHeight()
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(top = AgenteMetrics.topStrip)
                .background(colors.panel)
                .draggable(
                    state = rememberDraggableState { delta ->
                        scope.launch { offset.snapTo((offset.value + delta).coerceIn(-widthPx, 0f)) }
                    },
                    orientation = Orientation.Horizontal,
                    onDragStopped = { velocity ->
                        if (offset.value < -widthPx / 3f || velocity < -600f) onClose()
                        else offset.animateTo(0f, motion.spec(AgenteTokens.Motion.fast))
                    }
                )
        ) {
            DrawerContent(model = model, onClose = onClose)
        }
    }
}

@Composable
private fun DrawerContent(model: AgenteViewModel, onClose: () -> Unit) {
    val colors = AgenteTheme.colors
    val conversations = remember(model.chats, model.space) { model.chats.filter { it.space == model.space.wire } }
    val grouped = remember(conversations) { groupByDay(conversations) }
    val spaceIndex = Space.entries.indexOf(model.space)

    Column(modifier = Modifier.fillMaxSize().navigationBarsPadding().padding(vertical = 10.dp)) {
        // The search field is a door, not a filter: tapping it opens the modal,
        // which is where searching actually happens.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .height(44.dp)
                .clip(RoundedCornerShape(AgenteTokens.Shape.rowRadius))
                .background(colors.muted)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null
                ) {
                    model.openSearch()
                    onClose()
                }
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            AgenteIcon(
                icon = R.drawable.agente_ic_search,
                contentDescription = null,
                size = AgenteMetrics.rowGlyph,
                tint = colors.mutedForeground
            )
            AgenteText(
                text = stringResource(R.string.history_search),
                role = TextRole.Small,
                color = colors.mutedForeground,
                maxLines = 1
            )
        }

        Box(modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp)) {
            AgenteSegmentedControl(
                options = Space.entries.map { stringResource(it.labelRes) },
                selectedIndex = spaceIndex,
                onSelect = { index ->
                    model.switchSpace(Space.entries[index])
                    onClose()
                },
                stretch = true
            )
        }

        AgenteRow(
            title = stringResource(R.string.history_new_chat),
            onClick = {
                model.newChat()
                onClose()
            },
            leading = {
                AgenteIcon(
                    icon = R.drawable.agente_ic_plus,
                    contentDescription = null,
                    size = AgenteMetrics.rowGlyph,
                    tint = colors.mutedForeground
                )
            },
            modifier = Modifier.padding(horizontal = 6.dp)
        )

        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(top = 4.dp, bottom = 8.dp)
        ) {
            if (conversations.isEmpty()) {
                item {
                    AgenteEmptyState(
                        title = stringResource(R.string.history_empty),
                        hint = stringResource(R.string.history_empty_hint)
                    )
                }
            } else {
                grouped.forEach { (labelRes, rows) ->
                    item(key = "header-$labelRes") { AgenteSectionLabel(stringResource(labelRes)) }
                    items(rows, key = { it.id }) { chat ->
                        AgenteRow(
                            title = chat.title,
                            selected = chat.id == model.activeChat?.id,
                            onClick = {
                                model.openChat(chat)
                                onClose()
                            },
                            modifier = Modifier.padding(horizontal = 6.dp)
                        )
                    }
                }
            }
        }

        AgenteSeparator()
        AgenteRow(
            title = stringResource(R.string.settings_title),
            onClick = {
                model.settingsOpen = true
                onClose()
            },
            leading = {
                AgenteIcon(
                    icon = R.drawable.agente_ic_settings,
                    contentDescription = null,
                    size = AgenteMetrics.rowGlyph,
                    tint = colors.mutedForeground
                )
            },
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp)
        )
    }
}

/** Today, yesterday, this week, older — the desktop's sidebar groups. */
private fun groupByDay(chats: List<Conversation>): List<Pair<Int, List<Conversation>>> {
    val zone = ZoneId.systemDefault()
    val today = LocalDate.now(zone)
    val buckets = linkedMapOf<Int, MutableList<Conversation>>()
    chats.forEach { chat ->
        val day = Instant.ofEpochMilli(chat.updatedAt).atZone(zone).toLocalDate()
        val label = when {
            day == today -> R.string.history_today
            day == today.minusDays(1) -> R.string.history_yesterday
            day.isAfter(today.minusDays(7)) -> R.string.history_this_week
            else -> R.string.history_older
        }
        buckets.getOrPut(label) { mutableListOf() }.add(chat)
    }
    return buckets.map { (label, rows) -> label to rows.toList() }
}

/** The space glyphs: the desktop's rail, drawn at the drawer's own size. */
fun Space.icon(): Int = when (this) {
    Space.Home -> R.drawable.agente_ic_house
    Space.Code -> R.drawable.agente_ic_code_xml
    Space.Roleplay -> R.drawable.agente_ic_drama
}
