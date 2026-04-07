<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { t } from 'svelte-i18n';
  import { X } from 'lucide-svelte';
  import OnboardingStepWelcome from './OnboardingStepWelcome.svelte';
  import OnboardingStepRuntime from './OnboardingStepRuntime.svelte';
  import OnboardingStepModel from './OnboardingStepModel.svelte';
  import OnboardingStepReady from './OnboardingStepReady.svelte';
  import { gatherOnboardingHardware, markOnboardingComplete } from '$lib/services/onboarding';
  import { appStore } from '$lib/stores/app.svelte';
  import type { HardwareInfo } from '$lib/types/tauri';

  type Step = 'welcome' | 'runtime' | 'model' | 'ready';

  let step = $state<Step>('welcome');
  let hardware = $state<HardwareInfo | null>(null);
  let runtimePath = $state('');
  let modelFilename = $state('');

  const STEPS: Step[] = ['welcome', 'runtime', 'model', 'ready'];
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

<div class="fixed inset-0 z-[200] flex items-center justify-center bg-black/50" transition:fade={{ duration: 150 }}>
  <div
    class="flex h-full max-h-[640px] w-full max-w-xl flex-col rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-2xl"
    transition:fly={{ y: 20, duration: 200 }}
    role="dialog"
    aria-modal="true"
  >
    <!-- Header with step indicator and skip -->
    <div class="flex items-center justify-between border-b border-[var(--border)] px-6 py-3">
      <div class="flex items-center gap-2">
        {#each STEPS as s, i}
          <div
            class="h-1.5 rounded-full transition-all {i <= STEP_INDEX ? 'w-6 bg-[var(--primary)]' : 'w-3 bg-[var(--surface-highlight)]'}"
          ></div>
        {/each}
      </div>
      <button
        class="rounded-lg p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
        onclick={handleSkip}
        title={$t('onboarding.skipSetup')}
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <!-- Step content -->
    <div class="flex flex-1 overflow-y-auto py-6">
      {#if step === 'welcome'}
        <OnboardingStepWelcome onNext={goNext} />
      {:else if step === 'runtime'}
        <OnboardingStepRuntime onNext={handleRuntimeNext} onBack={goBack} />
      {:else if step === 'model'}
        <OnboardingStepModel onNext={handleModelNext} onBack={goBack} {hardware} />
      {:else if step === 'ready'}
        <OnboardingStepReady {modelFilename} onBack={goBack} onFinish={handleFinish} />
      {/if}
    </div>
  </div>
</div>
