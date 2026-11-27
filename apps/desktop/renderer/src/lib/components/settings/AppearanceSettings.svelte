<svelte:options runes={true} />

<!--
  Settings → Appearance. Laid out for scanning (Laws of UX): three groups —
  Color, Shape, Layout — each row a read-first line with the choice in effect
  named in its description, so the page answers "what is set" before it asks
  "what do you want". Choices are shown, not told: swatches, dots and
  live miniatures (each tile is the real composer, theme or work layout,
  small) carry a one-word name and no paragraph; the one in effect wears an
  accent ring.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { RotateCcw } from '$lib/icons';
  import { Button, SegmentedControl, Switch } from '$lib/components/ui';
  import ColorInput from '$lib/components/ui/ColorInput.svelte';
  import {
    ACCENT_PRESETS,
    AGENT_STYLE_IDS,
    COMPOSER_STYLE_IDS,
    DEFAULT_APPEARANCE,
    THEME_PRESETS,
    UI_STYLE_IDS,
    type ColorMode,
    type UiStyleId
  } from '$shared/appearance';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import ComposerStylePreview from './ComposerStylePreview.svelte';
  import ThemePreview from './ThemePreview.svelte';
  import WorkLayoutPreview from '$lib/features/code/work-layouts/WorkLayoutPreview.svelte';

  const prefs = $derived(appearanceStore.prefs);
  const resolvedMode = $derived(appearanceStore.resolvedMode);
  const changed = $derived(JSON.stringify(prefs) !== JSON.stringify(DEFAULT_APPEARANCE));
  const accentName = $derived(
    prefs.accent === 'custom' ? $t('appearance.accentCustom') : $t(`appearance.accent_${prefs.accent}`)
  );

  function onCustomColorInput(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    appearanceStore.update({ accent: 'custom', customAccentHex: value });
  }
</script>

<SettingsPage title={$t('appearance.title')} description={$t('appearance.description')}>
  {#snippet actions()}
    {#if changed}
      <Button variant="ghost" size="sm" onclick={() => appearanceStore.reset()}>
        <RotateCcw /> {$t('appearance.reset')}
      </Button>
    {/if}
  {/snippet}

  <!-- Color -->
  <SettingsSection title={$t('appearance.themeSection')}>
    <SettingsRow label={$t('appearance.mode')} control="auto">
      <SegmentedControl
        label={$t('appearance.mode')}
        value={prefs.mode}
        options={[
          { value: 'system', label: $t('appearance.modeSystem') },
          { value: 'light', label: $t('appearance.modeLight') },
          { value: 'dark', label: $t('appearance.modeDark') }
        ]}
        onchange={(value) => appearanceStore.setMode(value as ColorMode)}
      />
    </SettingsRow>

    <SettingsRow layout="stack" label={$t('appearance.palette')} description={$t(`appearance.theme_${prefs.theme}_desc`)}>
      <div class="tile-grid is-themes" role="radiogroup" aria-label={$t('appearance.palette')}>
        {#each THEME_PRESETS as preset (preset.id)}
          {@const selected = prefs.theme === preset.id}
          <Button
            variant="plain"
            type="button"
            role="radio"
            aria-checked={selected}
            class="tile {selected ? 'is-selected' : ''}"
            onclick={() => appearanceStore.update({ theme: preset.id })}
          >
            <span class="tile-art"><ThemePreview theme={preset.id} /></span>
            <span class="tile-label">{$t(`appearance.theme_${preset.id}`)}</span>
          </Button>
        {/each}
      </div>
    </SettingsRow>

    <SettingsRow label={$t('appearance.accent')} description={accentName} control="auto">
      <div class="accent-dots" role="radiogroup" aria-label={$t('appearance.accent')}>
        {#each ACCENT_PRESETS as preset (preset.id)}
          {@const selected = prefs.accent === preset.id}
          <Button
            variant="plain"
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={$t(`appearance.accent_${preset.id}`)}
            title={$t(`appearance.accent_${preset.id}`)}
            class="accent-dot {selected ? 'is-selected' : ''}"
            style="--dot: {resolvedMode === 'dark' ? preset.dark : preset.light}"
            onclick={() => appearanceStore.update({ accent: preset.id })}
          ></Button>
        {/each}
        <span class="accent-dot is-custom" class:is-selected={prefs.accent === 'custom'} title={$t('appearance.accentCustom')}>
          <ColorInput
            value={prefs.customAccentHex}
            aria-label={$t('appearance.accentCustom')}
            class="accent-custom-input"
            onclick={() => appearanceStore.update({ accent: 'custom' })}
            oninput={onCustomColorInput}
          />
        </span>
      </div>
    </SettingsRow>

    <SettingsRow label={$t('appearance.tintedBubbles')} description={$t('appearance.tintedBubblesDesc')} control="auto">
      <Switch
        label={$t('appearance.tintedBubbles')}
        checked={prefs.tintedUserBubbles}
        onchange={(checked) => appearanceStore.update({ tintedUserBubbles: checked })}
      />
    </SettingsRow>
  </SettingsSection>

  <!-- Shape -->
  <SettingsSection title={$t('appearance.styleSection')}>
    <SettingsRow label={$t('appearance.uiStyle')} description={$t(`appearance.uiStyle_${prefs.uiStyle}_desc`)} control="auto">
      <SegmentedControl
        label={$t('appearance.uiStyle')}
        value={prefs.uiStyle}
        options={UI_STYLE_IDS.map((id) => ({ value: id, label: $t(`appearance.uiStyle_${id}`) }))}
        onchange={(value) => appearanceStore.update({ uiStyle: value as UiStyleId })}
      />
    </SettingsRow>
  </SettingsSection>

  <!-- Layout -->
  <SettingsSection title={$t('appearance.layoutSection')}>
    <SettingsRow layout="stack" label={$t('appearance.composerStyle')} description={$t(`appearance.composer_${prefs.composerStyle}_desc`)}>
      <div class="tile-grid is-composers" role="radiogroup" aria-label={$t('appearance.composerStyle')}>
        {#each COMPOSER_STYLE_IDS as styleId (styleId)}
          {@const selected = prefs.composerStyle === styleId}
          <Button
            variant="plain"
            type="button"
            role="radio"
            aria-checked={selected}
            class="tile {selected ? 'is-selected' : ''}"
            onclick={() => appearanceStore.update({ composerStyle: styleId })}
          >
            <span class="tile-art"><ComposerStylePreview composerStyle={styleId} /></span>
            <span class="tile-label">{$t(`appearance.composer_${styleId}`)}</span>
          </Button>
        {/each}
      </div>
    </SettingsRow>

    <SettingsRow layout="stack" label={$t('appearance.agentStyle')} description={$t(`appearance.agent_${prefs.agentStyle}_desc`)}>
      <div class="tile-grid is-agents" role="radiogroup" aria-label={$t('appearance.agentStyle')}>
        {#each AGENT_STYLE_IDS as styleId (styleId)}
          {@const selected = prefs.agentStyle === styleId}
          <Button
            variant="plain"
            type="button"
            role="radio"
            aria-checked={selected}
            class="tile {selected ? 'is-selected' : ''}"
            onclick={() => appearanceStore.update({ agentStyle: styleId })}
          >
            <span class="tile-art"><WorkLayoutPreview layout={styleId} /></span>
            <span class="tile-label">{$t(`appearance.agent_${styleId}`)}</span>
          </Button>
        {/each}
      </div>
    </SettingsRow>
  </SettingsSection>
</SettingsPage>

<style>
  /* ── Tiles: the picture is the choice ────────────────────────────────── */
  .tile-grid {
    display: grid;
    gap: 1rem 0.75rem;
    margin-top: 0.75rem;
  }
  .tile-grid.is-themes { grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); }
  .tile-grid.is-composers { grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); }
  .tile-grid.is-agents { grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); }

  .tile-grid :global(.tile) {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .tile-art {
    display: flex;
    overflow: hidden;
    border-radius: var(--float-row-radius);
    box-shadow: 0 0 0 1px var(--border);
    transition: box-shadow var(--motion-instant) var(--motion-ease);
  }

  .tile-grid :global(.tile:hover .tile-art) { box-shadow: 0 0 0 1px var(--border-hover); }
  .tile-grid :global(.tile.is-selected .tile-art) { box-shadow: 0 0 0 2px var(--brand-accent); }
  .tile-grid :global(.tile:focus-visible) { outline: none; }
  .tile-grid :global(.tile:focus-visible .tile-art) { box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--brand-accent); }

  .tile-label {
    overflow: hidden;
    padding-inline: 0.125rem;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile-grid :global(.tile:hover .tile-label),
  .tile-grid :global(.tile.is-selected .tile-label) { color: var(--foreground); }
  .tile-grid :global(.tile.is-selected .tile-label) { font-weight: 500; }

  /* ── Accent dots ─────────────────────────────────────────────────────── */
  .accent-dots {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .accent-dots :global(.accent-dot) {
    position: relative;
    display: inline-flex;
    width: 1.375rem;
    height: 1.375rem;
    flex: none;
    padding: 0;
    border: 0;
    border-radius: 9999px;
    background: var(--dot);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
    cursor: pointer;
    transition: transform var(--motion-instant) var(--motion-ease), box-shadow var(--motion-instant) var(--motion-ease);
  }
  .accent-dots :global(.accent-dot:hover) { transform: scale(1.08); }
  .accent-dots :global(.accent-dot.is-selected),
  .accent-dots :global(.accent-dot:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--dot, var(--brand-accent));
  }

  /* Custom: the colour well itself, ringed by a hue wheel until it is chosen. */
  .accent-dot.is-custom {
    overflow: visible;
    background: conic-gradient(#e8793a, #e05d7b, #8b5cf6, #3b82f6, #2f9e73, #e5b454, #e8793a);
  }
  .accent-dot.is-custom.is-selected { --dot: var(--brand-accent); }
  .accent-dot.is-custom :global(.accent-custom-input) {
    width: 100%;
    height: 100%;
    border-radius: 9999px;
    opacity: 0;
  }
  .accent-dot.is-custom.is-selected :global(.accent-custom-input) { opacity: 1; }
  .accent-dot.is-custom :global(.accent-custom-input::-webkit-color-swatch-wrapper) { padding: 0; }
  .accent-dot.is-custom :global(.accent-custom-input::-webkit-color-swatch) {
    border: 0;
    border-radius: 9999px;
  }

  /* Message box, theme and agent work: each tile is the real thing, small
     (ComposerStylePreview, ThemePreview, WorkLayoutPreview). */
</style>
