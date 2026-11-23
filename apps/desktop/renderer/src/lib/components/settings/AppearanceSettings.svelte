<svelte:options runes={true} />

<!--
  Settings → Appearance: color mode, surface theme palettes, accent colors,
  interface geometry style, and prompt shell layouts. Changes apply at once
  and stay on this computer.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Check, RotateCcw } from '$lib/icons';
  import { Button, SegmentedControl, Switch } from '$lib/components/ui';
  import ColorInput from '$lib/components/ui/ColorInput.svelte';
  import {
    ACCENT_PRESETS,
    COMPOSER_STYLE_IDS,
    DEFAULT_APPEARANCE,
    THEME_PRESETS,
    UI_STYLE_IDS,
    type ColorMode,
    type ComposerStyleId,
    type ThemePresetId,
    type UiStyleId
  } from '$shared/appearance';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsSection from './SettingsSection.svelte';

  const prefs = $derived(appearanceStore.prefs);
  const resolvedMode = $derived(appearanceStore.resolvedMode);
  const changed = $derived(JSON.stringify(prefs) !== JSON.stringify(DEFAULT_APPEARANCE));

  let customColor = $derived(prefs.customAccentHex);

  function selectTheme(theme: ThemePresetId) {
    appearanceStore.update({ theme });
  }

  function selectUiStyle(uiStyle: UiStyleId) {
    appearanceStore.update({ uiStyle });
  }

  function selectComposerStyle(composerStyle: ComposerStyleId) {
    appearanceStore.update({ composerStyle });
  }

  function onCustomColorInput(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    appearanceStore.update({ accent: 'custom', customAccentHex: value });
  }
</script>

<SettingsPage title={$t('appearance.title')} description={$t('appearance.description')}>
  <!-- Live mini-preview -->
  <div class="preview-stage" aria-label={$t('appearance.preview')}>
    <div class="preview-messages">
      <div class="preview-user-bubble">{$t('appearance.previewUser')}</div>
      <div class="preview-assistant-row">
        <span class="preview-accent-dot" aria-hidden="true"></span>
        <span>{$t('appearance.previewAssistant')}</span>
      </div>
    </div>

    <div class="preview-composer-wrap">
      <div class="preview-shell" data-preview-composer={prefs.composerStyle}>
        <div class="preview-shell-input">
          {#if prefs.composerStyle === 'terminal'}
            <span class="preview-term-prompt">›</span>
          {/if}
          <span class="preview-placeholder">{$t('appearance.previewPlaceholder')}</span>
          {#if prefs.composerStyle === 'agente' || prefs.composerStyle === 'terminal' || prefs.composerStyle === 'minimal'}
            <span class="preview-send-btn" aria-hidden="true">↑</span>
          {/if}
        </div>
        {#if prefs.composerStyle !== 'agente'}
          <div class="preview-shell-bar">
            <span class="preview-chips">
              <span class="preview-chip">+</span>
              <span class="preview-chip">Model</span>
            </span>
            {#if prefs.composerStyle === 'pill' || prefs.composerStyle === 'card'}
              <span class="preview-send-btn" aria-hidden="true">↑</span>
            {/if}
          </div>
        {/if}
      </div>
      {#if prefs.composerStyle === 'agente'}
        <div class="preview-external-tray">
          <span class="preview-chip">+</span>
          <span class="preview-chip">Model</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Theme -->
  <SettingsSection title={$t('appearance.themeSection')}>
    <SettingsRow label={$t('appearance.mode')} description={$t('appearance.modeDesc')} control="auto">
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

    <SettingsRow layout="stack" label={$t('appearance.palette')} description={$t('appearance.paletteDesc')}>
      <div class="theme-grid mt-2.5" role="radiogroup" aria-label={$t('appearance.palette')}>
        {#each THEME_PRESETS as preset (preset.id)}
          {@const palette = preset[resolvedMode]}
          {@const selected = prefs.theme === preset.id}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="theme-card"
            class:is-selected={selected}
            onclick={() => selectTheme(preset.id)}
          >
            <div class="theme-swatch" style:background={palette.background}>
              <div class="theme-swatch-rail" style:background={palette.sidebar}></div>
              <div class="theme-swatch-canvas">
                <span class="theme-swatch-line" style:background={palette.foreground}></span>
                <span class="theme-swatch-card" style:background={palette.card}></span>
                <span class="theme-swatch-dot" style:background={palette.accentSwatch}></span>
              </div>
            </div>
            <span class="theme-card-label">
              <span>{$t(`appearance.theme_${preset.id}`)}</span>
              {#if selected}<Check class="h-3.5 w-3.5 text-[var(--brand-accent)]" />{/if}
            </span>
          </button>
        {/each}
      </div>
    </SettingsRow>
  </SettingsSection>

  <!-- Colors -->
  <SettingsSection title={$t('appearance.colorsSection')}>
    <SettingsRow layout="stack" label={$t('appearance.accent')} description={$t('appearance.accentDesc')}>
      <div class="accent-row mt-2.5" role="radiogroup" aria-label={$t('appearance.accent')}>
        {#each ACCENT_PRESETS as preset (preset.id)}
          {@const selected = prefs.accent === preset.id}
          {@const dotColor = resolvedMode === 'dark' ? preset.dark : preset.light}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="accent-pill"
            class:is-selected={selected}
            onclick={() => appearanceStore.update({ accent: preset.id })}
          >
            <span class="accent-dot" style:background={dotColor}></span>
            <span>{$t(`appearance.accent_${preset.id}`)}</span>
          </button>
        {/each}

        <label class="accent-pill accent-custom" class:is-selected={prefs.accent === 'custom'}>
          <ColorInput
            value={customColor}
            aria-label={$t('appearance.accentCustom')}
            class="h-4 w-4 rounded-full"
            oninput={onCustomColorInput}
          />
          <span>{$t('appearance.accentCustom')}</span>
        </label>
      </div>
    </SettingsRow>

    <SettingsRow
      label={$t('appearance.tintedBubbles')}
      description={$t('appearance.tintedBubblesDesc')}
      control="auto"
    >
      <Switch
        label={$t('appearance.tintedBubbles')}
        checked={prefs.tintedUserBubbles}
        onchange={(checked) => appearanceStore.update({ tintedUserBubbles: checked })}
      />
    </SettingsRow>
  </SettingsSection>

  <!-- Interface Style -->
  <SettingsSection title={$t('appearance.styleSection')}>
    <SettingsRow layout="stack" label={$t('appearance.uiStyle')} description={$t('appearance.uiStyleDesc')}>
      <div class="style-grid mt-2.5" role="radiogroup" aria-label={$t('appearance.uiStyle')}>
        {#each UI_STYLE_IDS as styleId (styleId)}
          {@const selected = prefs.uiStyle === styleId}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="choice-card"
            class:is-selected={selected}
            onclick={() => selectUiStyle(styleId)}
          >
            <div class="choice-header">
              <span class="choice-title">{$t(`appearance.uiStyle_${styleId}`)}</span>
              {#if selected}<Check class="h-3.5 w-3.5 text-[var(--brand-accent)]" />{/if}
            </div>
            <p class="choice-desc">{$t(`appearance.uiStyle_${styleId}_desc`)}</p>
          </button>
        {/each}
      </div>
    </SettingsRow>
  </SettingsSection>

  <!-- Prompt Shell -->
  <SettingsSection title={$t('appearance.promptSection')}>
    <SettingsRow layout="stack" label={$t('appearance.composerStyle')} description={$t('appearance.composerStyleDesc')}>
      <div class="composer-grid mt-2.5" role="radiogroup" aria-label={$t('appearance.composerStyle')}>
        {#each COMPOSER_STYLE_IDS as styleId (styleId)}
          {@const selected = prefs.composerStyle === styleId}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="choice-card composer-card-option"
            class:is-selected={selected}
            onclick={() => selectComposerStyle(styleId)}
          >
            <div class="wireframe-box" data-wireframe={styleId} aria-hidden="true">
              <div class="wf-shell">
                <div class="wf-top">
                  {#if styleId === 'terminal'}<span class="wf-prompt">›</span>{/if}
                  <span class="wf-line"></span>
                  {#if styleId === 'agente' || styleId === 'terminal' || styleId === 'minimal'}
                    <span class="wf-send"></span>
                  {/if}
                </div>
                {#if styleId !== 'agente'}
                  <div class="wf-bottom">
                    <span class="wf-dots"><span></span><span></span></span>
                    {#if styleId === 'pill' || styleId === 'card'}
                      <span class="wf-send"></span>
                    {/if}
                  </div>
                {/if}
              </div>
              {#if styleId === 'agente'}
                <div class="wf-tray"><span></span><span></span></div>
              {/if}
            </div>

            <div class="choice-header">
              <span class="choice-title">{$t(`appearance.composer_${styleId}`)}</span>
              {#if selected}<Check class="h-3.5 w-3.5 text-[var(--brand-accent)]" />{/if}
            </div>
            <p class="choice-desc">{$t(`appearance.composer_${styleId}_desc`)}</p>
          </button>
        {/each}
      </div>
    </SettingsRow>
  </SettingsSection>

  <div class="flex justify-end">
    <Button variant="ghost" size="sm" disabled={!changed} onclick={() => appearanceStore.reset()}>
      <RotateCcw /> {$t('appearance.reset')}
    </Button>
  </div>
</SettingsPage>

<style>
  .preview-stage {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: var(--radius-xl);
    background: var(--card);
    border: 1px solid var(--border);
  }

  .preview-messages {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .preview-user-bubble {
    align-self: flex-end;
    max-width: 80%;
    padding: 0.45rem 0.75rem;
    border-radius: var(--bubble-radius);
    background: var(--user-bubble);
    color: var(--user-bubble-text);
    font-size: var(--text-sm);
  }

  .preview-assistant-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
    color: var(--prose-ink);
  }

  .preview-accent-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 9999px;
    background: var(--brand-accent);
    flex: none;
  }

  .preview-composer-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .preview-shell {
    border: 1px solid var(--composer-ring);
    border-radius: var(--composer-radius);
    background: var(--composer-surface);
    padding: 0.5rem 0.625rem 0.5rem 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    transition: border-radius var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease);
  }

  .preview-shell[data-preview-composer='pill'] {
    border-radius: 1.5rem;
    padding: 0.625rem 0.625rem 0.5rem 0.95rem;
  }

  .preview-shell[data-preview-composer='card'] {
    border-radius: 1.05rem;
    padding: 0.7rem 0.65rem 0.55rem 0.875rem;
    gap: 0.65rem;
  }

  .preview-shell[data-preview-composer='terminal'] {
    border-radius: 0.375rem;
    border-left: 2px solid var(--brand-accent);
    font-family: var(--font-mono);
  }

  .preview-shell[data-preview-composer='minimal'] {
    background: transparent;
    border-color: transparent;
    border-bottom: 1px solid var(--brand-accent);
    border-radius: 0;
    padding-inline: 0.25rem;
  }

  .preview-shell-input {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .preview-term-prompt {
    color: var(--brand-accent);
    font-weight: 600;
  }

  .preview-placeholder {
    flex: 1;
    font-size: var(--text-sm);
    color: var(--composer-placeholder);
  }

  .preview-shell-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .preview-chips,
  .preview-external-tray {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .preview-chip {
    display: inline-flex;
    align-items: center;
    height: 1.25rem;
    padding: 0 0.45rem;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--muted-foreground);
    font-size: 0.7rem;
  }

  .preview-send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-sm);
    background: var(--foreground);
    color: var(--background);
    font-size: 0.75rem;
    font-weight: 600;
    flex: none;
  }

  .preview-shell[data-preview-composer='pill'] .preview-send-btn {
    border-radius: 9999px;
  }

  .preview-shell[data-preview-composer='card'] .preview-send-btn {
    border-radius: 0.45rem;
    background: var(--brand-accent);
    color: #ffffff;
  }

  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7.25rem, 1fr));
    gap: 0.625rem;
  }

  .theme-card {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.4rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--motion-instant) var(--motion-ease), background-color var(--motion-instant) var(--motion-ease);
  }

  .theme-card:hover {
    border-color: var(--border-hover);
  }

  .theme-card.is-selected {
    border-color: var(--brand-accent);
    box-shadow: 0 0 0 1px var(--brand-accent);
  }

  .theme-swatch {
    display: flex;
    height: 3.1rem;
    border-radius: calc(var(--radius-md) - 1px);
    overflow: hidden;
    border: 1px solid rgb(128 128 128 / 0.16);
  }

  .theme-swatch-rail {
    width: 28%;
    height: 100%;
    border-right: 1px solid rgb(128 128 128 / 0.14);
  }

  .theme-swatch-canvas {
    position: relative;
    flex: 1;
    padding: 0.45rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .theme-swatch-line {
    width: 65%;
    height: 3px;
    border-radius: 9999px;
    opacity: 0.55;
  }

  .theme-swatch-card {
    width: 88%;
    height: 1rem;
    border-radius: 3px;
    border: 1px solid rgb(128 128 128 / 0.16);
  }

  .theme-swatch-dot {
    position: absolute;
    right: 0.4rem;
    top: 0.4rem;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 9999px;
  }

  .theme-card-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-inline: 0.2rem;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--foreground);
  }

  .accent-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .accent-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    height: 2rem;
    padding: 0 0.7rem 0 0.5rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: border-color var(--motion-instant) var(--motion-ease), background-color var(--motion-instant) var(--motion-ease);
  }

  .accent-pill:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
  }

  .accent-pill.is-selected {
    border-color: var(--brand-accent);
    box-shadow: 0 0 0 1px var(--brand-accent);
  }

  .accent-dot {
    width: 0.875rem;
    height: 0.875rem;
    border-radius: 9999px;
    flex: none;
  }

  .style-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 0.625rem;
  }

  .composer-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.625rem;
  }

  .choice-card {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--motion-instant) var(--motion-ease), background-color var(--motion-instant) var(--motion-ease);
  }

  .choice-card:hover {
    border-color: var(--border-hover);
  }

  .choice-card.is-selected {
    border-color: var(--brand-accent);
    box-shadow: 0 0 0 1px var(--brand-accent);
  }

  .choice-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .choice-title {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--foreground);
  }

  .choice-desc {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    line-height: 1.4;
  }

  .wireframe-box {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 0.35rem;
  }

  .wf-shell {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.45rem 0.5rem;
    background: var(--composer-surface);
    border: 1px solid var(--border-hover);
    border-radius: 0.45rem;
  }

  .wireframe-box[data-wireframe='pill'] .wf-shell {
    border-radius: 1rem;
  }

  .wireframe-box[data-wireframe='card'] .wf-shell {
    border-radius: 0.7rem;
    padding-top: 0.55rem;
  }

  .wireframe-box[data-wireframe='terminal'] .wf-shell {
    border-radius: 0.25rem;
    border-left: 2px solid var(--brand-accent);
  }

  .wireframe-box[data-wireframe='minimal'] .wf-shell {
    background: transparent;
    border-color: transparent;
    border-bottom: 1px solid var(--border-hover);
    border-radius: 0;
    padding-inline: 0.15rem;
  }

  .wf-top,
  .wf-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.35rem;
  }

  .wf-prompt {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--brand-accent);
    line-height: 1;
  }

  .wf-line {
    flex: 1;
    height: 4px;
    border-radius: 9999px;
    background: var(--muted-foreground);
    opacity: 0.35;
  }

  .wf-send {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 3px;
    background: var(--foreground);
    opacity: 0.75;
    flex: none;
  }

  .wireframe-box[data-wireframe='pill'] .wf-send {
    border-radius: 9999px;
  }

  .wireframe-box[data-wireframe='card'] .wf-send {
    background: var(--brand-accent);
    opacity: 1;
  }

  .wf-dots,
  .wf-tray {
    display: flex;
    gap: 0.25rem;
  }

  .wf-dots span,
  .wf-tray span {
    width: 1rem;
    height: 0.3rem;
    border-radius: 9999px;
    background: var(--muted-foreground);
    opacity: 0.3;
  }
</style>
