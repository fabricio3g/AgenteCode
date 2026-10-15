<svelte:options runes={true} />

<!--
  First-run setup, and the same wizard reopened from Settings → General.

  Drawn like the app itself: the steps sit on the sunken ground at the left,
  the way the sidebar does, in the picker's grammar — the current step has
  the accent `›` and the band, a finished one a check and what you chose
  ("English · Dark"), so the rail doubles as the summary. The step's content
  is a raised sheet beside them, one centred column, its footer starting on
  the content's left edge.

  Four stages, each optional past the first: say hello (language, theme),
  choose how models run (a cloud provider with its key, or llama.cpp and a
  model on this computer), voice (a model to read replies aloud, dictation),
  and a summary. Closing at any point keeps whatever was already set up and
  marks setup as done; nothing installed is ever removed here.
-->

<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { t, locale } from 'svelte-i18n';
  import { Check } from 'lucide-svelte';
  import { SUPPORTED_UI_LANGUAGES, normalizeLocaleCode } from '$lib/i18n';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import { providerLabel } from '$lib/utils/providers';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { motionFade } from '$lib/utils/transitions';
  import { markOnboardingComplete } from '$lib/services/onboarding';
  import { appStore } from '$lib/stores/app.svelte';
  import SetupWelcome from './SetupWelcome.svelte';
  import SetupModels from './SetupModels.svelte';
  import SetupVoice from './SetupVoice.svelte';
  import SetupDone from './SetupDone.svelte';

  type Stage = 'welcome' | 'models' | 'voice' | 'done';
  const STAGES: Stage[] = ['welcome', 'models', 'voice', 'done'];

  let stage = $state<Stage>('welcome');
  const index = $derived(STAGES.indexOf(stage));
  const labels = $derived<Record<Stage, string>>({
    welcome: $t('onboarding.stage.welcome'),
    models: $t('onboarding.stage.models'),
    voice: $t('onboarding.stage.voice'),
    done: $t('onboarding.stage.done')
  });

  /** What each step settled, in a few words: the rail's second line. */
  const summaries = $derived.by<Record<Stage, string>>(() => {
    const language = SUPPORTED_UI_LANGUAGES.find((lang) => lang.code === normalizeLocaleCode($locale))?.label ?? '';
    const theme = themeStore.current === 'dark' ? $t('generalSettings.dark') : $t('generalSettings.light');
    const local = appStore.config?.llm?.local?.model;
    const provider = appStore.activeProviderName;
    const model = appStore.backendMode === 'local'
      ? (local ? String(local).split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? '' : '')
      : provider && appStore.config?.llm?.providers?.[provider]?.model ? providerLabel(provider) : '';
    return {
      welcome: [language, theme].filter(Boolean).join(' · '),
      models: model || $t('onboarding.rail.notSet'),
      voice: speechEngine.active?.title || $t('onboarding.rail.optional'),
      done: ''
    };
  });

  function go(next: Stage) {
    stage = next;
  }

  function close() {
    void markOnboardingComplete();
    appStore.onboardingOpen = false;
    appStore.onboardingCompleted = true;
  }
</script>

<div class="ui-modal-backdrop" use:modalLayer={{ onclose: close }} transition:motionFade={{ duration: 100 }}>
  <div class="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <nav class="setup-nav" aria-label={$t('onboarding.progress')}>
      <div class="setup-brand">
        <img src="./app-icon.svg" alt="" aria-hidden="true" draggable="false" />
        <h2 id="setup-title">{$t('onboarding.setupTitle')}</h2>
      </div>
      <ol class="setup-progress">
        {#each STAGES as item, i (item)}
          <li class:is-current={i === index} class:is-done={i < index} aria-current={i === index ? 'step' : undefined}>
            <span class="step-mark" aria-hidden="true">{#if i < index}<Check class="size-3" />{:else if i === index}›{/if}</span>
            <span class="step-text">
              <span class="step-name"><span class="sr-only">{i + 1}. </span>{labels[item]}</span>
              {#if summaries[item]}<span class="step-summary">{summaries[item]}</span>{/if}
            </span>
          </li>
        {/each}
      </ol>
      <Button variant="ghost" size="sm" class="setup-skip" onclick={close}>{$t('onboarding.skipSetup')}<kbd>Esc</kbd></Button>
    </nav>

    <div class="setup-sheet">
      {#if stage === 'welcome'}
        <SetupWelcome onnext={() => go('models')} />
      {:else if stage === 'models'}
        <SetupModels onback={() => go('welcome')} onnext={() => go('voice')} />
      {:else if stage === 'voice'}
        <SetupVoice onback={() => go('models')} onnext={() => go('done')} />
      {:else}
        <SetupDone onback={() => go('voice')} onfinish={close} />
      {/if}
    </div>
  </div>
</div>

<style>
  /* Nearly the whole window, drawn like the app: the ground, and a sheet
     resting on it. The step's content keeps a readable column in the middle. */
  .setup {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    width: calc(100vw - 1.5rem);
    height: calc(100dvh - 1.5rem);
    padding: 6px;
    border-radius: var(--radius-2xl);
    background: var(--sidebar);
    box-shadow: var(--float-shadow);
  }
  .setup-nav {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem 0.75rem 0.75rem 0.5rem;
  }
  .setup-brand {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0 0.375rem;
  }
  .setup-brand img { width: 1.75rem; height: 1.75rem; flex-shrink: 0; }
  .setup-brand h2 {
    margin: 0;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .setup-progress {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* A step reads like a picker row: two lines, the accent `›` on the current one. */
  .setup-progress li {
    display: flex;
    min-height: 2.75rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--float-row-radius);
    color: var(--muted-foreground);
  }
  .setup-progress li.is-current {
    background: var(--nav-current-bg);
    box-shadow: var(--nav-current-ring), var(--control-shadow);
    color: var(--foreground);
  }
  .step-mark {
    display: inline-flex;
    width: 0.75rem;
    flex-shrink: 0;
    justify-content: center;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
  }
  .is-current .step-mark { color: var(--brand-accent); font-weight: 600; }
  .step-text { display: flex; min-width: 0; flex-direction: column; gap: 0.0625rem; }
  .step-name { font-size: var(--text-sm); }
  .is-current .step-name { font-weight: 600; }
  .step-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .setup-nav :global(.setup-skip) {
    width: 100%;
    margin-top: auto;
    justify-content: space-between;
    color: var(--muted-foreground);
  }
  .setup-nav :global(.setup-skip kbd) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .setup-sheet {
    display: flex;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    /* One centred column for the step and its footer, however wide the window. */
    --setup-gutter: max(1.75rem, calc((100% - 40rem) / 2));
    border-radius: var(--sheet-radius);
    background: var(--background);
    box-shadow: var(--sheet-shadow);
  }
  @media (max-width: 640px) {
    .setup { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    .setup-nav { gap: 0.5rem; }
    .setup-progress { flex-direction: row; flex-wrap: wrap; }
    .setup-nav :global(.setup-skip) { display: none; }
  }
</style>
