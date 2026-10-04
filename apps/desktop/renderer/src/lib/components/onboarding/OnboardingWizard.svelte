<svelte:options runes={true} />

<script lang="ts">
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { onMount } from 'svelte';
  import { motionFade } from '$lib/utils/transitions';
  import { t } from 'svelte-i18n';
  import { X } from 'lucide-svelte';
  import OnboardingStepWelcome from './OnboardingStepWelcome.svelte';
  import OnboardingStepRuntime from './OnboardingStepRuntime.svelte';
  import OnboardingStepModel from './OnboardingStepModel.svelte';
  import OnboardingStepTtsModel from './OnboardingStepTtsModel.svelte';
  import OnboardingStepReady from './OnboardingStepReady.svelte';
  import { gatherOnboardingHardware, markOnboardingComplete } from '$lib/services/onboarding';
  import { appStore } from '$lib/stores/app.svelte';
  import type { HardwareInfo } from '$lib/types/bridge';

  type Step = 'welcome' | 'runtime' | 'model' | 'tts-model' | 'ready';

  let step = $state<Step>('welcome');
  let hardware = $state<HardwareInfo | null>(null);
  let runtimePath = $state('');
  let modelFilename = $state('');

  const STEPS: Step[] = ['welcome', 'runtime', 'model', 'tts-model', 'ready'];
  const stepLabels = $derived([$t('onboarding.welcome'), $t('onboarding.runtime'), $t('onboarding.model'), $t('onboarding.downloadTtsModel'), $t('onboarding.ready')]);
  const STEP_INDEX = $derived(STEPS.indexOf(step));

  function goNext() {
    const idx = STEP_INDEX;
    if (idx < STEPS.length - 1) step = STEPS[idx + 1];
  }
  function goBack() {
    const idx = STEP_INDEX;
    if (idx > 0) step = STEPS[idx - 1];
  }

  function handleRuntimeNext(path: string) {
    runtimePath = path;
    goNext();
  }
  function handleModelNext(filename: string) {
    modelFilename = filename;
    goNext();
  }
  function handleTtsModelNext() {
    goNext();
  }
  function handleFinish() {
    appStore.onboardingOpen = false;
    appStore.onboardingCompleted = true;
  }
  function handleSkip() {
    void markOnboardingComplete();
    appStore.onboardingOpen = false;
    appStore.onboardingCompleted = true;
  }

  onMount(async () => {
    const result = await gatherOnboardingHardware();
    hardware = result.hardware;
  });
</script>

<!-- The setup can be reopened from settings; closing never changes installed models. -->
<div class="ui-modal-backdrop" use:modalLayer={{ onclose: handleSkip }} transition:motionFade={{ duration: 100 }}>
  <div class="ui-modal-surface setup-wizard" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <header class="setup-header">
      <div>
        <h2 id="setup-title">{$t('onboarding.setupTitle')}</h2>
        <p>{$t('onboarding.stepOf', { values: { current: STEP_INDEX + 1, total: STEPS.length } })}</p>
      </div>
      <button type="button" class="ui-icon-button" onclick={handleSkip} aria-label={$t('onboarding.skipSetup')} title={$t('onboarding.skipSetup')}><X class="size-4" /></button>
    </header>
    <ol class="setup-progress" aria-label={$t('onboarding.setupTitle')}>
      {#each STEPS as stage, index}
        <li class:current={index === STEP_INDEX} class:complete={index < STEP_INDEX} aria-current={index === STEP_INDEX ? 'step' : undefined}>
          <span class="stage-number">{index + 1}</span><span>{stepLabels[index]}</span>
        </li>
      {/each}
    </ol>

    <!-- Step content -->
    <div class="setup-content">
      {#if step === 'welcome'}
        <OnboardingStepWelcome onNext={goNext} />
      {:else if step === 'runtime'}
        <OnboardingStepRuntime onNext={handleRuntimeNext} onBack={goBack} />
      {:else if step === 'model'}
        <OnboardingStepModel onNext={handleModelNext} onBack={goBack} {hardware} />
      {:else if step === 'tts-model'}
        <OnboardingStepTtsModel onNext={handleTtsModelNext} onBack={goBack} />
      {:else if step === 'ready'}
        <OnboardingStepReady {modelFilename} onBack={goBack} onFinish={handleFinish} />
      {/if}
    </div>
  </div>
</div>

<style>
  .setup-wizard { width: min(640px, 100%); max-width: 640px; height: min(620px, calc(100dvh - 48px)); min-height: 0; padding: 0; overflow: hidden; }
  .setup-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.25rem 1.5rem 1rem; }
  .setup-header h2 { font-size: var(--text-base); font-weight: 600; }
  .setup-header p { color: var(--muted-foreground); font-size: var(--text-xs); margin-top: .25rem; }
  .setup-progress { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .5rem; padding: 0 1.5rem 1rem; list-style: none; }
  .setup-progress li { display: flex; align-items: center; gap: .375rem; color: var(--muted-foreground); font-size: var(--text-xs); min-width: 0; padding-top: .5rem; border-top: 2px solid var(--border-subtle); }
  .setup-progress li > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .setup-progress .current { color: var(--foreground); border-color: var(--muted-foreground); }
  .setup-progress .complete { border-color: var(--border); }
  .stage-number { font-variant-numeric: tabular-nums; opacity: .65; }
  .setup-content { display: flex; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .5rem 0 1.5rem; font-size: var(--text-base); line-height: 1.6; }
  @media (max-width: 480px) { .setup-progress li { flex-direction: column; align-items: flex-start; } .setup-header, .setup-progress { padding-left: 1rem; padding-right: 1rem; } }
</style>
