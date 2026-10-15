package dev.agente.android.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.agente.android.AgenteViewModel
import dev.agente.android.R
import dev.agente.android.data.ThemeChoice
import dev.agente.android.runtime.ProviderChoice
import dev.agente.android.ui.design.AgenteButton
import dev.agente.android.ui.design.AgenteButtonVariant
import dev.agente.android.ui.design.AgenteField
import dev.agente.android.ui.design.AgenteFormRow
import dev.agente.android.ui.design.AgenteIconButton
import dev.agente.android.ui.design.AgenteMetrics
import dev.agente.android.ui.design.AgentePickerList
import dev.agente.android.ui.design.AgenteSearchField
import dev.agente.android.ui.design.AgenteSectionLabel
import dev.agente.android.ui.design.AgenteSegmentedControl
import dev.agente.android.ui.design.AgenteSheet
import dev.agente.android.ui.design.AgenteText
import dev.agente.android.ui.design.AgenteTheme
import dev.agente.android.ui.design.PickerEntry
import dev.agente.android.ui.design.TextRole

/**
 * Settings as a screen, not a sheet: a back arrow, then sections of rows with
 * their values hard right. Each row that needs more than a value opens its own
 * small panel, so the screen itself stays a list you can read in one pass.
 */
@Composable
fun SettingsScreen(model: AgenteViewModel) {
    val colors = AgenteTheme.colors
    var picking by remember { mutableStateOf(false) }
    var editingKey by remember { mutableStateOf(false) }
    var editingPersona by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { model.refreshVaultState() }

    Column(modifier = Modifier.fillMaxSize()) {
        BackHandler(enabled = true) { model.settingsOpen = false }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(AgenteMetrics.topStrip)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            AgenteIconButton(
                icon = R.drawable.agente_ic_chevron_left,
                contentDescription = stringResource(R.string.action_back),
                onClick = { model.settingsOpen = false }
            )
            AgenteText(
                text = stringResource(R.string.settings_title),
                role = TextRole.Base,
                weight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 6.dp)
            )
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 8.dp, vertical = 4.dp)
        ) {
            AgenteSectionLabel(stringResource(R.string.providers_models))
            AgenteFormRow(
                label = stringResource(R.string.model_picker_title),
                value = model.selection.model.ifBlank { stringResource(R.string.model_configure_provider) },
                onClick = { picking = true }
            )
            AgenteFormRow(
                label = stringResource(R.string.providers_api_key),
                value = if (model.hasKey) stringResource(R.string.providers_key_saved)
                else stringResource(R.string.providers_needs_key),
                onClick = { editingKey = true }
            )
            AgenteText(
                text = stringResource(R.string.vault_note),
                role = TextRole.Caption,
                color = colors.mutedForeground,
                modifier = Modifier.padding(horizontal = AgenteMetrics.rowInset, vertical = 2.dp)
            )

            AgenteSectionLabel(stringResource(R.string.roleplay_persona))
            AgenteFormRow(
                label = stringResource(R.string.persona_name),
                value = model.selection.persona,
                onClick = { editingPersona = true }
            )

            AgenteSectionLabel(stringResource(R.string.settings_appearance))
            Box(modifier = Modifier.padding(horizontal = AgenteMetrics.rowInset, vertical = 6.dp)) {
                AgenteSegmentedControl(
                    options = listOf(
                        stringResource(R.string.option_auto),
                        stringResource(R.string.settings_light),
                        stringResource(R.string.settings_dark)
                    ),
                    selectedIndex = ThemeChoice.entries.indexOf(model.theme),
                    onSelect = { index -> model.chooseTheme(ThemeChoice.entries[index]) },
                    stretch = true
                )
            }
            AgenteText(
                text = stringResource(R.string.settings_theme_desc),
                role = TextRole.Caption,
                color = colors.mutedForeground,
                modifier = Modifier.padding(horizontal = AgenteMetrics.rowInset)
            )

            AgenteSectionLabel(stringResource(R.string.settings_general))
            AgenteText(
                text = stringResource(R.string.sync_note_local),
                role = TextRole.Caption,
                color = colors.mutedForeground,
                modifier = Modifier.padding(horizontal = AgenteMetrics.rowInset)
            )
            if (model.pendingChanges > 0) {
                AgenteText(
                    text = pluralStringResource(R.plurals.sync_note_pending, model.pendingChanges, model.pendingChanges),
                    role = TextRole.Caption,
                    color = colors.mutedForeground,
                    modifier = Modifier.padding(horizontal = AgenteMetrics.rowInset, vertical = 4.dp)
                )
            }
            Box(modifier = Modifier.padding(bottom = 16.dp))
        }
    }

    if (picking) {
        ModelPickerSheet(
            providers = model.providers,
            discoveredProvider = model.discoveredProvider,
            discoveredModels = model.discoveredModels,
            selectedProvider = model.selection.provider,
            selectedModel = model.selection.model,
            onPick = { provider, pickedModel ->
                model.saveModel(provider, pickedModel, model.selection.persona)
                picking = false
            },
            onDismiss = { picking = false }
        )
    }
    if (editingKey) {
        KeySheet(model = model, onDismiss = { editingKey = false })
    }
    if (editingPersona) {
        PersonaSheet(model = model, onDismiss = { editingPersona = false })
    }
}

/** The provider's key: entered once, described afterwards, never shown back. */
@Composable
private fun KeySheet(model: AgenteViewModel, onDismiss: () -> Unit) {
    val providers = model.providers
    var provider by remember { mutableStateOf(model.selection.provider.ifBlank { providers.firstOrNull()?.id.orEmpty() }) }
    var key by remember { mutableStateOf("") }
    AgenteSheet(
        title = stringResource(R.string.providers_api_key),
        onDismiss = onDismiss,
        footer = {
            AgenteButton(
                label = stringResource(R.string.settings_save),
                onClick = {
                    model.saveProviderKey(provider, key)
                    onDismiss()
                },
                variant = AgenteButtonVariant.Solid,
                enabled = key.isNotBlank()
            )
        }
    ) {
        AgentePickerList(
            entries = providers.map { PickerEntry(id = it.id, label = it.name, current = it.id == provider) },
            onPick = { provider = it }
        )
        AgenteField(
            label = stringResource(R.string.providers_api_key),
            value = key,
            onValueChange = { key = it },
            placeholder = stringResource(R.string.providers_key_placeholder),
            supporting = stringResource(R.string.vault_note),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done)
        )
        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            AgenteButton(
                label = if (model.discovering) stringResource(R.string.status_loading)
                else stringResource(R.string.providers_refresh_models),
                onClick = { model.discoverModels(provider, key) },
                enabled = !model.discovering,
                leadingIcon = R.drawable.agente_ic_loader_circle
            )
        }
        if (model.discoveredProvider == provider && model.discoveredModels.isNotEmpty()) {
            AgenteText(
                text = stringResource(R.string.providers_models_hint),
                role = TextRole.Caption,
                color = AgenteTheme.colors.mutedForeground,
                modifier = Modifier.padding(horizontal = AgenteMetrics.rowInset)
            )
        }
        Box(modifier = Modifier.padding(bottom = 8.dp))
    }
}

/** The name the model calls you inside a scene. */
@Composable
private fun PersonaSheet(model: AgenteViewModel, onDismiss: () -> Unit) {
    var persona by remember { mutableStateOf(model.selection.persona) }
    AgenteSheet(
        title = stringResource(R.string.roleplay_persona),
        onDismiss = onDismiss,
        footer = {
            AgenteButton(
                label = stringResource(R.string.settings_save),
                onClick = {
                    model.savePersona(persona)
                    onDismiss()
                },
                variant = AgenteButtonVariant.Solid,
                enabled = persona.isNotBlank()
            )
        }
    ) {
        AgenteField(
            label = stringResource(R.string.persona_name),
            value = persona,
            onValueChange = { persona = it },
            placeholder = stringResource(R.string.settings_enter_name)
        )
        Box(modifier = Modifier.padding(bottom = 8.dp))
    }
}

/** Every provider's models, filtered as you type; the one in effect carries `◈`. */
@Composable
private fun ModelPickerSheet(
    providers: List<ProviderChoice>,
    discoveredProvider: String,
    discoveredModels: List<String>,
    selectedProvider: String,
    selectedModel: String,
    onPick: (String, String) -> Unit,
    onDismiss: () -> Unit
) {
    var query by remember { mutableStateOf("") }
    val entries = remember(providers, discoveredProvider, discoveredModels, query, selectedProvider, selectedModel) {
        buildList {
            providers.forEach { provider ->
                val catalog = provider.models + if (provider.id == discoveredProvider) discoveredModels else emptyList()
                val models = catalog.distinct().filter { query.isBlank() || it.contains(query, ignoreCase = true) }
                if (models.isEmpty()) return@forEach
                add(PickerEntry(id = "header-${provider.id}", label = provider.name, header = true))
                models.forEach { id ->
                    add(
                        PickerEntry(
                            id = "${provider.id}\u0000$id",
                            label = id,
                            current = provider.id == selectedProvider && id == selectedModel
                        )
                    )
                }
            }
        }
    }
    AgenteSheet(title = stringResource(R.string.model_picker_title), onDismiss = onDismiss, fullHeight = true) {
        AgenteSearchField(
            value = query,
            onValueChange = { query = it },
            placeholder = stringResource(R.string.model_picker_search)
        )
        if (entries.isEmpty()) {
            AgenteText(
                text = stringResource(R.string.providers_no_models_key),
                role = TextRole.Small,
                color = AgenteTheme.colors.mutedForeground,
                modifier = Modifier.padding(vertical = 12.dp)
            )
        } else {
            AgentePickerList(
                entries = entries,
                onPick = { id ->
                    val parts = id.split('\u0000')
                    if (parts.size == 2) onPick(parts[0], parts[1])
                }
            )
        }
        Box(modifier = Modifier.padding(bottom = 12.dp))
    }
}
