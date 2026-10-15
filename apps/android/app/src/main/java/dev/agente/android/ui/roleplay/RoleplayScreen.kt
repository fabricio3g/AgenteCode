package dev.agente.android.ui.roleplay

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.data.Character
import dev.agente.android.ui.design.AgenteAvatar
import dev.agente.android.ui.design.AgenteButton
import dev.agente.android.ui.design.AgenteButtonVariant
import dev.agente.android.ui.design.AgenteEmptyState
import dev.agente.android.ui.design.AgenteField
import dev.agente.android.ui.design.AgenteIconButton
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgenteRow
import dev.agente.android.ui.design.AgenteSectionLabel
import dev.agente.android.ui.design.AgenteSheet
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.TextRole

/**
 * Roleplay: the character library. Scenes already running are conversations, so
 * they live in the drawer with every other conversation — tapping a character
 * here starts a one-to-one scene, and editing is its own action so a scene
 * cannot start by accident while changing a card.
 */
@Composable
fun RoleplayScreen(model: AgenteViewModel) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 12.dp)
    ) {
        item {
            AgenteSectionLabel(
                text = stringResource(R.string.roleplay_characters),
                trailing = {
                    AgenteIconButton(
                        icon = R.drawable.agente_ic_plus,
                        contentDescription = stringResource(R.string.roleplay_new_character),
                        onClick = { model.editCharacter() }
                    )
                }
            )
        }
        if (model.characters.isEmpty()) {
            item {
                AgenteEmptyState(
                    title = stringResource(R.string.roleplay_pick_character),
                    hint = stringResource(R.string.roleplay_pick_hint)
                )
            }
        } else {
            items(model.characters, key = { it.id }) { character ->
                CharacterRow(character, model)
            }
        }
    }
}

@Composable
private fun CharacterRow(character: Character, model: AgenteViewModel) {
    val colors = AgenteTheme.colors
    AgenteRow(
        title = character.name,
        subtitle = character.notes.takeIf { it.isNotBlank() },
        onClick = { model.startScene(character) },
        leading = { AgenteAvatar(character.name) },
        trailing = {
            AgenteIconButton(
                icon = R.drawable.agente_ic_pencil,
                contentDescription = stringResource(R.string.action_edit),
                onClick = { model.editCharacter(character) },
                size = 36.dp,
                glyph = AgenteMetrics.rowGlyph,
                tint = colors.mutedForeground
            )
        },
        modifier = Modifier.padding(horizontal = 6.dp)
    )
}

/** Creating or editing a character: three fields, one honest save. */
@Composable
fun CharacterSheet(model: AgenteViewModel) {
    val editing = model.characterEditing
    var name by remember(editing) { mutableStateOf(editing?.name.orEmpty()) }
    var notes by remember(editing) { mutableStateOf(editing?.notes.orEmpty()) }
    var opening by remember(editing) { mutableStateOf(editing?.greeting.orEmpty()) }
    AgenteSheet(
        title = stringResource(if (editing == null) R.string.roleplay_new_character else R.string.action_edit),
        onDismiss = { model.characterEditorOpen = false },
        fullHeight = false,
        footer = {
            AgenteButton(
                label = stringResource(R.string.action_save),
                onClick = { model.saveCharacter(name, notes, opening) },
                variant = AgenteButtonVariant.Solid,
                enabled = name.isNotBlank()
            )
        }
    ) {
        AgenteField(
            label = stringResource(R.string.character_name),
            value = name,
            onValueChange = { name = it },
            placeholder = stringResource(R.string.character_name_placeholder)
        )
        AgenteField(
            label = stringResource(R.string.character_notes),
            value = notes,
            onValueChange = { notes = it },
            supporting = stringResource(R.string.character_notes_hint),
            singleLine = false,
            minLines = 3,
            maxLines = 6
        )
        AgenteField(
            label = stringResource(R.string.character_opening),
            value = opening,
            onValueChange = { opening = it },
            placeholder = stringResource(R.string.character_opening_placeholder),
            supporting = stringResource(R.string.character_no_opening),
            singleLine = false,
            minLines = 3,
            maxLines = 8
        )
    }
}

/** The scene's own header: who is speaking, above the transcript. */
@Composable
fun SceneSpeaker(character: Character?, persona: String) {
    val colors = AgenteTheme.colors
    Column(
        modifier = Modifier.padding(horizontal = AgenteMetrics.gutter, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        AgenteText(
            text = character?.name ?: stringResource(R.string.space_roleplay),
            role = TextRole.Small,
            color = colors.secondary,
            weight = FontWeight.Medium,
            maxLines = 1
        )
        AgenteText(
            text = stringResource(R.string.roleplay_persona) + " \u00B7 " + persona,
            role = TextRole.Caption,
            color = colors.mutedForeground,
            maxLines = 1
        )
    }
}
