package dev.agente.android.ui.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.Space
import dev.agente.android.ui.chat.AgenteComposer
import dev.agente.android.ui.chat.ComposerStatusRow
import dev.agente.android.ui.chat.TranscriptScreen
import dev.agente.android.ui.code.CodeScreen
import dev.agente.android.ui.design.AgenteIconButton
import dev.agente.android.ui.design.AgenteMenu
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteNotice
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.MenuAction
import dev.agente.android.ui.design.TextRole
import dev.agente.android.ui.home.HomeScreen
import dev.agente.android.ui.roleplay.CharacterSheet
import dev.agente.android.ui.roleplay.RoleplayScreen
import dev.agente.android.ui.roleplay.SceneSpeaker
import dev.agente.android.ui.search.SearchModal
import dev.agente.android.ui.settings.SettingsScreen
import kotlinx.coroutines.delay

/**
 * The whole app: one top bar, the current space's content, the composer, and
 * whatever panel is open. Every plane, hairline and glyph comes from the design
 * system, so no screen owns chrome of its own.
 */
@Composable
fun AgenteShell(model: AgenteViewModel) {
    AgenteTheme(choice = model.theme) {
        AgenteShellContent(model)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgenteShellContent(model: AgenteViewModel) {
    val colors = AgenteTheme.colors
    var drawerOpen by remember { mutableStateOf(false) }
    val imeVisible = WindowInsets.isImeVisible
    val composing = model.activeChat != null || model.space == Space.Home

    Box(modifier = Modifier.fillMaxSize().background(colors.canvas)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.systemBars.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
        ) {
            TopBar(model = model, onOpenDrawer = { drawerOpen = true })
            Box(modifier = Modifier.weight(1f)) {
                when {
                    model.activeChat != null -> Column(modifier = Modifier.fillMaxSize()) {
                        val character = model.characters.firstOrNull { it.id == model.activeChat?.characterId }
                        if (character != null) SceneSpeaker(character, model.selection.persona)
                        TranscriptScreen(model)
                    }
                    model.space == Space.Home -> HomeScreen(model)
                    model.space == Space.Code -> CodeScreen()
                    else -> RoleplayScreen(model)
                }
            }
            model.notice?.let { notice ->
                val text = when {
                    notice.text != null && notice.resource != 0 ->
                        stringResource(notice.resource) + " \u00B7 " + notice.text
                    notice.text != null -> notice.text
                    else -> stringResource(notice.resource)
                }
                AgenteNotice(
                    text = text,
                    onDismiss = model::dismissNotice,
                    modifier = Modifier.padding(horizontal = AgenteMetrics.gutter, vertical = 6.dp)
                )
            }
            if (composing) ComposerDock(model)
        }
        AgenteDrawer(model = model, open = drawerOpen, onClose = { drawerOpen = false })
        if (model.searchOpen) SearchModal(model)
        if (model.characterEditorOpen) CharacterSheet(model)
        if (model.settingsOpen) SettingsScreen(model)
    }

    // Back dismisses the keyboard, a panel or the drawer before it navigates.
    BackHandler(
        enabled = model.activeChat != null && !imeVisible && !drawerOpen &&
            !model.searchOpen && !model.settingsOpen && !model.characterEditorOpen
    ) {
        model.newChat()
    }
}

/**
 * The bar: the drawer on the left, the title, then the space's own actions. A
 * conversation gets one overflow instead of a back arrow — the drawer is the way
 * back, and the system's Back gesture already leaves the thread.
 */
@Composable
private fun TopBar(model: AgenteViewModel, onOpenDrawer: () -> Unit) {
    val colors = AgenteTheme.colors
    var menu by remember { mutableStateOf(false) }
    val title = model.activeChat?.title ?: stringResource(model.space.labelRes)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(AgenteMetrics.topStrip)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        AgenteIconButton(
            icon = R.drawable.agente_ic_menu,
            contentDescription = stringResource(model.space.labelRes),
            onClick = onOpenDrawer
        )
        AgenteText(
            text = title,
            role = TextRole.Base,
            weight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 6.dp)
        )
        if (model.activeChat == null) {
            AgenteIconButton(
                icon = R.drawable.agente_ic_square_pen,
                contentDescription = stringResource(R.string.history_new_chat),
                onClick = model::newChat
            )
        } else {
            Box {
                AgenteIconButton(
                    icon = R.drawable.agente_ic_ellipsis,
                    contentDescription = stringResource(R.string.action_more),
                    onClick = { menu = true },
                    tint = colors.secondary
                )
                if (menu) {
                    AgenteMenu(
                        actions = listOf(
                            MenuAction(stringResource(R.string.history_new_chat), R.drawable.agente_ic_square_pen) {
                                model.newChat()
                            },
                            MenuAction(stringResource(R.string.settings_title), R.drawable.agente_ic_settings) {
                                model.settingsOpen = true
                            }
                        ),
                        onDismiss = { menu = false }
                    )
                }
            }
        }
    }
}

/**
 * The composer dock: what the run is doing above it, then the field itself. It
 * carries the navigation inset because the drawer is the only other plane that
 * touches the bottom edge.
 */
@Composable
private fun ComposerDock(model: AgenteViewModel) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val running = model.workingChatId != null
    LaunchedEffect(running) {
        while (running) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }
    val elapsed = model.workingSince?.let { ((now - it) / 1000).coerceAtLeast(0) } ?: 0

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = AgenteMetrics.gutter)
            .padding(top = 6.dp, bottom = 10.dp)
            .windowInsetsPadding(WindowInsets.navigationBars)
            .imePadding(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (running) {
            ComposerStatusRow(
                label = stringResource(R.string.status_working) + " \u00B7 " + elapsed + "s",
                modifier = Modifier.padding(start = 6.dp)
            )
        }
        AgenteComposer(
            draft = model.draft,
            onDraftChange = model::updateDraft,
            placeholder = stringResource(
                if (model.activeChat?.characterId != null) R.string.roleplay_scene_placeholder
                else R.string.composer_placeholder
            ),
            modelLabel = model.selection.model.ifEmpty { stringResource(R.string.model_configure_provider) },
            onModelClick = { model.settingsOpen = true },
            running = running,
            onSend = model::send,
            onStop = model::stop
        )
    }
}
