<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { motionFade, motionFly } from '$lib/utils/transitions';
  import { t } from 'svelte-i18n';
  import { X } from 'lucide-svelte';
  import OnboardingStepWelcome from './OnboardingStepWelcome.svelte';
  import OnboardingStepRuntime from './OnboardingStepRuntime.svelte';
  import OnboardingStepModel from './OnboardingStepModel.svelte';
  import OnboardingStepTtsModel from './OnboardingStepTtsModel.svelte';
  import OnboardingStepReady from './OnboardingStepReady.svelte';
  import { gatherOnboardingHardware, markOnboardingComplete } from '$lib/services/onboarding';
  import { appStore } from '$lib/stores/app.svelte';
  import type { HardwareInfo } from '$lib/types/tauri';

  type Step = 'welcome' | 'runtime' | 'model' | 'tts-model' | 'ready';

  let step = $state<Step>('welcome');
  let hardware = $state<HardwareInfo | null>(null);
  let runtimePath = $state('');
  let modelFilename = $state('');

  const STEPS: Step[] = ['welcome', 'runtime', 'model', 'tts-model', 'ready'];
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
    markOnboardingComplete();
    appStore.onboardingOpen = false;
    appStore.onboardingCompleted = true;
  }

  onMount(async () => {
    const result = await gatherOnboardingHardware();
    hardware = result.hardware;
  });
</script>

<div class="fixed inset-0 z-[200] flex items-center justify-center bg-overlay" transition:motionFade={{ duration: 150 }}>
  <div
    class="flex h-full max-h-[580px] w-full max-w-lg flex-col rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-2xl"
    transition:motionFly={{ y: 20, duration: 200 }}
    role="dialog"
    aria-modal="true"
  >
    <!-- Header with step indicator -->
    <div class="flex items-center justify-between border-b border-[var(--border)] px-5 py-3.5">
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-1.5">
          {#each STEPS as s, i}
            <div
              class="h-1.5 w-1.5 rounded-full transition-all {i <= STEP_INDEX ? 'bg-[var(--text)] scale-125' : 'bg-[var(--border)]'}"
            ></div>
          {/each}
        </div>
        <span class="text-xs font-medium text-[var(--text-muted)]">{$t('onboarding.stepOf', { values: { current: STEP_INDEX + 1, total: STEPS.length } })}</span>
      </div>
      <button
        class="rounded-lg border border-transparent p-1.5 text-[var(--text-muted)] transition hover:border-[var(--border)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        onclick={handleSkip}
        title={$t('onboarding.skipSetup')}
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <!-- Step content -->
    <div class="flex flex-1 overflow-y-auto px-1 py-2">
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
