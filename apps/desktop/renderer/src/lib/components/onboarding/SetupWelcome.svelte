<svelte:options runes={true} />

<!-- Step one: how the app reads to you. Settings rows — label hard left, the
     control hard right — and the theme as two small pictures of the window,
     so the choice is seen rather than named. Each change applies at once. -->

<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import { Button, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import { APP_NAME } from '$lib/app-meta';
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode, setUiLocale } from '$lib/i18n';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { accessibilityStore } from '$lib/stores/accessibility.svelte';
  import SetupFooter from './SetupFooter.svelte';

  let { onnext }: { onnext: () => void } = $props();

  const themes = $derived([
    { id: 'light' as const, label: $t('generalSettings.light') },
    { id: 'dark' as const, label: $t('generalSettings.dark') }
  ]);
  const sizes = $derived([
    { value: '0.9', label: $t('onboarding.prefs.smaller') },
    { value: '1', label: $t('onboarding.prefs.default') },
    { value: '1.15', label: $t('onboarding.prefs.larger') }
  ]);
  const prefs = $derived(accessibilityStore.prefs);
  const size = $derived(sizes.find((item) => Math.abs(Number(item.value) - prefs.textScale) < 0.01)?.value ?? '');
</script>

<div class="setup-step">
  <div>
    <h3 class="setup-title">{$t('onboarding.welcomeTitle', { values: { app: APP_NAME } })}</h3>
    <p class="setup-lead">{$t('onboarding.welcomeLead')}</p>
  </div>

  <div class="setup-prefs">
    <div class="setup-pref">
      <div class="pref-text">
        <span class="pref-label">{$t('onboarding.chooseLanguage')}</span>
        <span class="pref-desc">{$t('onboarding.prefs.languageDesc')}</span>
      </div>
      <Select
        class="w-44"
        value={normalizeLocaleCode($locale)}
        options={SUPPORTED_UI_LANGUAGES.map((lang) => ({ value: lang.code, label: lang.label }))}
        onchange={(code) => setUiLocale(code)}
      />
    </div>

    <div class="setup-pref">
      <div class="pref-text">
        <span class="pref-label">{$t('generalSettings.theme')}</span>
        <span class="pref-desc">{$t('onboarding.prefs.themeDesc')}</span>
      </div>
      <div class="theme-tiles" role="radiogroup" aria-label={$t('generalSettings.theme')}>
        {#each themes as theme (theme.id)}
          <Button
            variant="plain"
            class="theme-tile {themeStore.current === theme.id ? 'is-selected' : ''}"
            role="radio"
            aria-checked={themeStore.current === theme.id}
            onclick={() => themeStore.set(theme.id)}
          >
            <span class="tile-window tile-{theme.id}" aria-hidden="true">
              <span class="tile-rail"></span>
              <span class="tile-sheet"><span></span><span></span></span>
            </span>
            <span class="tile-label">{theme.label}</span>
          </Button>
        {/each}
      </div>
    </div>

    <div class="setup-pref">
      <div class="pref-text">
        <span class="pref-label">{$t('accessibility.textSize')}</span>
        <span class="pref-desc">{$t('accessibility.textSizeDesc')}</span>
      </div>
      <SegmentedControl
        label={$t('accessibility.textSize')}
        value={size}
        options={sizes}
        onchange={(value) => accessibilityStore.update({ textScale: Number(value) })}
      />
    </div>

    <div class="setup-pref">
      <div class="pref-text">
        <span class="pref-label">{$t('onboarding.prefs.legibleFont')}</span>
        <span class="pref-desc">Atkinson Hyperlegible</span>
      </div>
      <Switch
        label={$t('onboarding.prefs.legibleFont')}
        checked={prefs.font === 'hyperlegible'}
        onchange={(on) => accessibilityStore.update({ font: on ? 'hyperlegible' : 'default' })}
      />
    </div>

    <div class="setup-pref">
      <div class="pref-text">
        <span class="pref-label">{$t('accessibility.reduceMotion')}</span>
        <span class="pref-desc">{$t('accessibility.reduceMotionDesc')}</span>
      </div>
      <Switch
        label={$t('accessibility.reduceMotion')}
        checked={prefs.reduceMotion === 'on'}
        onchange={(on) => accessibilityStore.update({ reduceMotion: on ? 'on' : 'system' })}
      />
    </div>
  </div>
</div>

<SetupFooter primaryLabel={$t('onboarding.getStarted')} onprimary={onnext} />

<style>
  .theme-tiles { display: flex; gap: 0.5rem; }
  .theme-tiles :global(.theme-tile) {
    display: flex;
    height: auto;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem;
    border-radius: var(--radius-lg, 0.625rem);
    color: var(--muted-foreground);
  }
  .theme-tiles :global(.theme-tile:hover) { background: var(--surface-hover); }
  .theme-tiles :global(.theme-tile.is-selected) { background: var(--muted); color: var(--foreground); }
  .theme-tiles :global(.theme-tile.is-selected .tile-window) { box-shadow: 0 0 0 2px var(--foreground); }

  /* A window in miniature: the sunken rail and the raised sheet. */
  .tile-window {
    display: flex;
    width: 4.5rem;
    height: 3rem;
    gap: 3px;
    padding: 3px;
    border-radius: 0.375rem;
    box-shadow: 0 0 0 1px var(--float-border);
  }
  .tile-light { background: #ececec; }
  .tile-light .tile-sheet { background: #ffffff; }
  .tile-light .tile-sheet span { background: #d9d9d9; }
  .tile-dark { background: #050505; }
  .tile-dark .tile-sheet { background: #1a1a1a; }
  .tile-dark .tile-sheet span { background: #3a3a3a; }
  .tile-rail { width: 0.75rem; }
  .tile-sheet {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    padding: 5px;
    border-radius: 3px;
  }
  .tile-sheet span { height: 3px; border-radius: 2px; }
  .tile-sheet span:last-child { width: 60%; }
  .tile-label { font-size: var(--text-xs); }
</style>
