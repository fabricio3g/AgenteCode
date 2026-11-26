<svelte:options runes={true} />

<!--
  Settings → Appearance. Laid out for scanning (Laws of UX): three groups —
  Color, Shape, Layout — each row a read-first line with the choice in effect
  named in its description, so the page answers "what is set" before it asks
  "what do you want". Choices are shown, not told: swatches, dots and
  wireframes carry a one-word name and no paragraph; the one in effect wears an
  accent ring. The preview at the top repaints with every change.
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
    getThemePreset,
    type ColorMode,
    type UiStyleId
  } from '$shared/appearance';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsSection from './SettingsSection.svelte';

  const prefs = $derived(appearanceStore.prefs);
  const resolvedMode = $derived(appearanceStore.resolvedMode);
  const changed = $derived(JSON.stringify(prefs) !== JSON.stringify(DEFAULT_APPEARANCE));
  const previewPalette = $derived(getThemePreset(prefs.theme)[resolvedMode]);
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

  <!-- A miniature window: the sidebar tone on the left, the canvas with a sent
       message, a reply and the message box on the right. -->
  <div class="preview" aria-label={$t('appearance.preview')} style:--preview-rail={previewPalette.sidebar}>
    <div class="preview-rail" aria-hidden="true">
      <span class="preview-rail-line is-current"></span>
      <span class="preview-rail-line"></span>
      <span class="preview-rail-line is-short"></span>
    </div>
    <div class="preview-canvas">
      <div class="preview-user-bubble">{$t('appearance.previewUser')}</div>
      <div class="preview-assistant-row">
        <span class="preview-accent-dot" aria-hidden="true"></span>
        <span>{$t('appearance.previewAssistant')}</span>
      </div>
      <div class="preview-composer" data-preview-composer={prefs.composerStyle}>
        <div class="preview-shell">
          {#if prefs.composerStyle === 'terminal'}<span class="preview-term-prompt" aria-hidden="true">›</span>{/if}
          <span class="preview-placeholder">{$t('appearance.previewPlaceholder')}</span>
          <span class="preview-send" aria-hidden="true">↑</span>
        </div>
      </div>
    </div>
  </div>

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
          {@const palette = preset[resolvedMode]}
          {@const selected = prefs.theme === preset.id}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="tile"
            class:is-selected={selected}
            onclick={() => appearanceStore.update({ theme: preset.id })}
          >
            <span class="tile-art theme-art" style:background={palette.background} aria-hidden="true">
              <span class="theme-art-rail" style:background={palette.sidebar}></span>
              <span class="theme-art-canvas">
                <span class="theme-art-line" style:background={palette.foreground}></span>
                <span class="theme-art-card" style:background={palette.card}></span>
                <span class="theme-art-dot" style:background={palette.accentSwatch}></span>
              </span>
            </span>
            <span class="tile-label">{$t(`appearance.theme_${preset.id}`)}</span>
          </button>
        {/each}
      </div>
    </SettingsRow>

    <SettingsRow label={$t('appearance.accent')} description={accentName} control="auto">
      <div class="accent-dots" role="radiogroup" aria-label={$t('appearance.accent')}>
        {#each ACCENT_PRESETS as preset (preset.id)}
          {@const selected = prefs.accent === preset.id}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={$t(`appearance.accent_${preset.id}`)}
            title={$t(`appearance.accent_${preset.id}`)}
            class="accent-dot"
            class:is-selected={selected}
            style:--dot={resolvedMode === 'dark' ? preset.dark : preset.light}
            onclick={() => appearanceStore.update({ accent: preset.id })}
          ></button>
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
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="tile"
            class:is-selected={selected}
            onclick={() => appearanceStore.update({ composerStyle: styleId })}
          >
            <span class="tile-art wire-art" aria-hidden="true">
              <span class="wireframe-box" data-wireframe={styleId}>
                <span class="wf-shell">
                  <span class="wf-top">
                    {#if styleId === 'terminal'}<span class="wf-prompt">›</span>{/if}
                    <span class="wf-line"></span>
                    {#if styleId === 'agente' || styleId === 'terminal' || styleId === 'minimal'}
                      <span class="wf-send"></span>
                    {/if}
                  </span>
                  {#if styleId !== 'agente'}
                    <span class="wf-bottom">
                      <span class="wf-dots"><span></span><span></span></span>
                      {#if styleId === 'pill' || styleId === 'card'}<span class="wf-send"></span>{/if}
                    </span>
                  {/if}
                </span>
                {#if styleId === 'agente'}
                  <span class="wf-tray"><span></span><span></span></span>
                {/if}
              </span>
            </span>
            <span class="tile-label">{$t(`appearance.composer_${styleId}`)}</span>
          </button>
        {/each}
      </div>
    </SettingsRow>

    <SettingsRow layout="stack" label={$t('appearance.agentStyle')} description={$t(`appearance.agent_${prefs.agentStyle}_desc`)}>
      <div class="tile-grid is-agents" role="radiogroup" aria-label={$t('appearance.agentStyle')}>
        {#each AGENT_STYLE_IDS as styleId (styleId)}
          {@const selected = prefs.agentStyle === styleId}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            class="tile"
            class:is-selected={selected}
            onclick={() => appearanceStore.update({ agentStyle: styleId })}
          >
            <span class="tile-art wire-art" aria-hidden="true">
              <span class="agent-wf" data-agent-wf={styleId}>
                {#if styleId === 'feed'}
                  <span class="aw-row"><span class="aw-stack"><span class="aw-circle"></span><span class="aw-circle"></span><span class="aw-circle"></span></span><span class="aw-bar w-1/3"></span></span>
                  <span class="aw-row"><span class="aw-sq"></span><span class="aw-col"><span class="aw-bar is-strong w-2/3"></span><span class="aw-bar is-thin w-1/3"></span></span></span>
                  <span class="aw-row"><span class="aw-sq"></span><span class="aw-col"><span class="aw-bar is-strong w-1/2"></span><span class="aw-bar is-thin w-2/5"></span></span></span>
                {:else if styleId === 'files'}
                  <span class="aw-row"><span class="aw-pill"></span><span class="aw-bar w-1/4"></span></span>
                  <span class="aw-row aw-filled"><span class="aw-sq is-sky"></span><span class="aw-bar is-strong w-1/2"></span><span class="aw-check"></span></span>
                  <span class="aw-row aw-filled"><span class="aw-sq is-ok"></span><span class="aw-bar is-strong w-2/5"></span><span class="aw-check"></span></span>
                {:else if styleId === 'plan'}
                  <span class="aw-row"><span class="aw-ring"></span><span class="aw-bar is-strong w-1/2"></span></span>
                  <span class="aw-row"><span class="aw-check"></span><span class="aw-bar w-3/5"></span></span>
                  <span class="aw-row"><span class="aw-circle is-accent"></span><span class="aw-bar is-strong w-1/2"></span></span>
                {:else if styleId === 'review'}
                  <span class="aw-row"><span class="aw-bar is-thin w-1/2"></span></span>
                  <span class="aw-card">
                    <span class="aw-row"><span class="aw-sq is-accent"></span><span class="aw-bar is-strong w-1/3"></span><span class="aw-pill"></span></span>
                    <span class="aw-line is-del"></span>
                    <span class="aw-line is-add"></span>
                  </span>
                {:else if styleId === 'research'}
                  <span class="aw-row"><span class="aw-sq"></span><span class="aw-bar is-strong w-2/5"></span><span class="aw-stack aw-push"><span class="aw-circle is-sky"></span><span class="aw-circle is-violet"></span><span class="aw-circle is-ok"></span></span></span>
                  <span class="aw-row"><span class="aw-sq"></span><span class="aw-bar is-strong w-1/3"></span></span>
                  <span class="aw-row"><span class="aw-pill"></span><span class="aw-pill"></span><span class="aw-pill"></span></span>
                {:else if styleId === 'timeline'}
                  <span class="aw-log">
                    <span class="aw-row"><span class="aw-time"></span><span class="aw-check"></span><span class="aw-bar is-strong w-1/2"></span></span>
                    <span class="aw-row"><span class="aw-time"></span><span class="aw-check"></span><span class="aw-bar is-strong w-2/5"></span></span>
                    <span class="aw-row"><span class="aw-time"></span><span class="aw-circle is-accent"></span><span class="aw-bar is-strong w-1/3"></span></span>
                  </span>
                {:else if styleId === 'tiles'}
                  <span class="aw-tiles">
                    <span class="aw-tile"><span class="aw-sq"></span></span>
                    <span class="aw-tile"><span class="aw-sq is-accent"></span></span>
                    <span class="aw-tile"><span class="aw-sq"></span></span>
                    <span class="aw-tile"><span class="aw-sq is-ok"></span></span>
                  </span>
                {:else}
                  <span class="aw-row"><span class="aw-chev"></span><span class="aw-bar w-1/2"></span></span>
                  <span class="aw-rail">
                    <span class="aw-row"><span class="aw-bar w-2/3"></span></span>
                    <span class="aw-row"><span class="aw-dot"></span><span class="aw-bar is-strong w-1/2"></span></span>
                  </span>
                {/if}
              </span>
            </span>
            <span class="tile-label">{$t(`appearance.agent_${styleId}`)}</span>
          </button>
        {/each}
      </div>
    </SettingsRow>
  </SettingsSection>
</SettingsPage>

<style>
  /* ── Preview: a miniature window ─────────────────────────────────────── */
  .preview {
    display: flex;
    overflow: hidden;
    min-height: 9.5rem;
    border-radius: var(--float-radius);
    background: var(--chat-bg, var(--background));
    box-shadow: 0 0 0 1px var(--border);
  }

  .preview-rail {
    display: flex;
    width: 22%;
    max-width: 9rem;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 0.75rem;
    background: var(--preview-rail);
    border-right: 1px solid var(--sidebar-border);
  }

  .preview-rail-line {
    height: 0.375rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--foreground) 14%, transparent);
  }
  .preview-rail-line.is-current { background: color-mix(in srgb, var(--foreground) 30%, transparent); }
  .preview-rail-line.is-short { width: 60%; }

  .preview-canvas {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 1.25rem;
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
    color: var(--prose-ink);
    font-size: var(--text-sm);
  }

  .preview-accent-dot {
    width: 0.5rem;
    height: 0.5rem;
    flex: none;
    border-radius: 9999px;
    background: var(--brand-accent);
  }

  .preview-composer { margin-top: auto; }

  .preview-shell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.5rem 0.875rem;
    border: 1px solid var(--composer-ring);
    border-radius: var(--composer-radius);
    background: var(--composer-surface);
    transition: border-radius var(--motion-fast) var(--motion-ease);
  }

  .preview-composer[data-preview-composer='terminal'] .preview-shell {
    border-left: 2px solid var(--brand-accent);
    font-family: var(--font-mono);
  }

  .preview-composer[data-preview-composer='minimal'] .preview-shell {
    border-color: transparent;
    border-bottom-color: var(--brand-accent);
    border-radius: 0;
    background: transparent;
    padding-inline: 0.25rem;
  }

  .preview-term-prompt {
    color: var(--brand-accent);
    font-weight: 600;
  }

  .preview-placeholder {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--composer-placeholder);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-send {
    display: inline-flex;
    width: 1.625rem;
    height: 1.625rem;
    flex: none;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--foreground) 12%, transparent);
    color: var(--foreground);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .preview-composer[data-preview-composer='card'] .preview-send {
    border-radius: calc(var(--float-row-radius) + 0.0625rem);
    background: var(--brand-accent);
    color: var(--brand-accent-fg);
  }

  .preview-composer[data-preview-composer='pill'] .preview-send {
    background: var(--foreground);
    color: var(--background);
  }

  /* ── Tiles: the picture is the choice ────────────────────────────────── */
  .tile-grid {
    display: grid;
    gap: 1rem 0.75rem;
    margin-top: 0.75rem;
  }
  .tile-grid.is-themes { grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr)); }
  .tile-grid.is-composers { grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr)); }
  .tile-grid.is-agents { grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); }

  .tile {
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

  .tile:hover .tile-art { box-shadow: 0 0 0 1px var(--border-hover); }
  .tile.is-selected .tile-art { box-shadow: 0 0 0 2px var(--brand-accent); }
  .tile:focus-visible { outline: none; }
  .tile:focus-visible .tile-art { box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--brand-accent); }

  .tile-label {
    overflow: hidden;
    padding-inline: 0.125rem;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile:hover .tile-label,
  .tile.is-selected .tile-label { color: var(--foreground); }
  .tile.is-selected .tile-label { font-weight: 500; }

  .theme-art { height: 3.5rem; }
  .theme-art-rail {
    width: 28%;
    border-right: 1px solid rgb(128 128 128 / 0.14);
  }
  .theme-art-canvas {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem;
  }
  .theme-art-line {
    width: 60%;
    height: 3px;
    border-radius: 9999px;
    opacity: 0.6;
  }
  .theme-art-card {
    width: 90%;
    height: 1.125rem;
    border-radius: 3px;
    box-shadow: 0 0 0 1px rgb(128 128 128 / 0.16);
  }
  .theme-art-dot {
    position: absolute;
    top: 0.45rem;
    right: 0.45rem;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 9999px;
  }

  .wire-art {
    min-height: 4.25rem;
    flex-direction: column;
    justify-content: center;
    padding: 0.625rem;
    background: var(--background);
  }
  .wire-art .wireframe-box { margin-bottom: 0; }

  /* ── Accent dots ─────────────────────────────────────────────────────── */
  .accent-dots {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .accent-dot {
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
  .accent-dot:hover { transform: scale(1.08); }
  .accent-dot.is-selected,
  .accent-dot:focus-visible {
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

  /* ── Wireframes (composer and work layouts) ──────────────────────────── */
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

  .agent-wf {
    display: flex;
    min-height: 3.75rem;
    flex-direction: column;
    justify-content: center;
    gap: 0.3rem;
  }
  .aw-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.3rem;
  }
  .aw-col {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.18rem;
  }
  .aw-bar {
    height: 3.5px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--foreground) 22%, transparent);
  }
  .aw-bar.is-strong { background: color-mix(in srgb, var(--foreground) 45%, transparent); }
  .aw-bar.is-thin { height: 2.5px; }
  .aw-sq {
    width: 0.85rem;
    height: 0.85rem;
    flex: none;
    border-radius: 0.22rem;
    background: color-mix(in srgb, var(--foreground) 12%, transparent);
  }
  .aw-circle,
  .aw-check {
    width: 0.6rem;
    height: 0.6rem;
    flex: none;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--foreground) 18%, transparent);
  }
  .aw-check { background: var(--success); }
  .aw-stack { display: inline-flex; }
  .aw-stack .aw-circle { box-shadow: 0 0 0 1.5px var(--background); }
  .aw-stack .aw-circle + .aw-circle { margin-left: -0.22rem; }
  .aw-push { margin-left: auto; }
  .aw-sq.is-sky, .aw-circle.is-sky { background: color-mix(in srgb, var(--accent-sky) 45%, transparent); }
  .aw-circle.is-violet { background: color-mix(in srgb, var(--accent-violet) 45%, transparent); }
  .aw-sq.is-ok, .aw-circle.is-ok { background: color-mix(in srgb, var(--success) 45%, transparent); }
  .aw-sq.is-accent, .aw-circle.is-accent { background: color-mix(in srgb, var(--brand-accent) 55%, transparent); }
  .aw-pill {
    width: 1.4rem;
    height: 0.45rem;
    flex: none;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--foreground) 12%, transparent);
  }
  .aw-row .aw-pill:last-child:not(:first-child) { margin-left: auto; }
  .aw-filled {
    padding: 0.15rem 0.25rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--foreground) 5%, transparent);
  }
  .aw-filled .aw-check { margin-left: auto; }
  .aw-ring {
    width: 0.85rem;
    height: 0.85rem;
    flex: none;
    border: 2px solid var(--success);
    border-right-color: color-mix(in srgb, var(--foreground) 15%, transparent);
    border-radius: 9999px;
  }
  .aw-card {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.3rem;
    background: var(--card);
  }
  .aw-card > .aw-row { padding: 0.18rem 0.25rem; }
  .aw-line { height: 0.32rem; }
  .aw-line.is-del { background: color-mix(in srgb, var(--error) 30%, transparent); }
  .aw-line.is-add { background: color-mix(in srgb, var(--success) 30%, transparent); }
  .aw-log {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .aw-time {
    width: 0.55rem;
    height: 2.5px;
    flex: none;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--foreground) 22%, transparent);
  }
  .aw-tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.22rem;
  }
  .aw-tile {
    display: flex;
    height: 1.2rem;
    padding: 0.18rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
  }
  .aw-tile .aw-sq { width: 0.5rem; height: 0.5rem; }
  .aw-chev {
    width: 0.3rem;
    height: 0.3rem;
    flex: none;
    margin-left: 0.1rem;
    border-right: 1.25px solid var(--muted-foreground);
    border-bottom: 1.25px solid var(--muted-foreground);
    transform: rotate(45deg);
  }
  .aw-rail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-left: 0.22rem;
    padding-left: 0.45rem;
    border-left: 1px solid var(--border-hover);
  }
  .aw-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex: none;
    border-radius: 9999px;
    background: var(--brand-accent);
  }
</style>
