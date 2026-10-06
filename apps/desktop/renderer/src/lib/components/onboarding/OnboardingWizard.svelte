<svelte:options runes={true} />

<!--
  First-run setup, and the same wizard reopened from Settings → General.

  Four stages, each optional past the first: say hello (language, theme),
  choose how models run (a cloud provider with its key, or llama.cpp and a
  model on this computer), voice (a model to read replies aloud, dictation),
  and a summary. Closing at any point keeps whatever was already set up and
  marks setup as done; nothing installed is ever removed here.
-->

<script lang="ts">
  import { Tooltip } from '$lib/components/ui';
  import { t } from 'svelte-i18n';
  import { X } from 'lucide-svelte';
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
  <div class="ui-modal-surface setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <header class="setup-header">
      <div class="min-w-0">
        <h2 id="setup-title">{$t('onboarding.setupTitle')}</h2>
        <ol class="setup-progress" aria-label={$t('onboarding.progress')}>
          {#each STAGES as item, i (item)}
            <li class:is-current={i === index} class:is-done={i < index} aria-current={i === index ? 'step' : undefined}>
              <span class="step-number">{i + 1}</span>{labels[item]}
            </li>
          {/each}
        </ol>
      </div>
      <Tooltip label={$t('onboarding.skipSetup')} position="bottom"><button type="button" class="ui-icon-button" onclick={close} aria-label={$t('onboarding.skipSetup')}>
        <X />
      </button></Tooltip>
    </header>

    <div class="setup-body">
      {#if stage === 'welcome'}
        <SetupWelcome onnext={() => go('models')} onskip={close} />
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
  .setup {
    width: min(40rem, 100%);
    height: min(40rem, calc(100dvh - 3rem));
    padding: 0;
  }

  .setup-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.125rem 1.5rem 0.875rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .setup-header h2 {
    color: var(--foreground);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .setup-progress {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin-top: 0.375rem;
    list-style: none;
  }

  .setup-progress li {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  .setup-progress li.is-current { color: var(--foreground); font-weight: 500; }

  .step-number {
    display: inline-flex;
    width: 1.125rem;
    height: 1.125rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--float-border);
    border-radius: 9999px;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  .is-current .step-number { border-color: var(--foreground); background: var(--foreground); color: var(--background); }
  .is-done .step-number { border-color: var(--border-hover); background: var(--surface-active); }

  .setup-body {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
  }
</style>
