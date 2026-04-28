<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { MessageSquare, ArrowLeft, ArrowRight, LoaderCircle, CheckCircle2, AlertTriangle } from 'lucide-svelte';
  import { loadLocalModel } from '$lib/services/runtime';
  import { getLocalModels } from '$lib/services/models';
  import { getInstalledRuntimes } from '$lib/services/files';
  import { markOnboardingComplete } from '$lib/services/onboarding';
  import { appStore } from '$lib/stores/app.svelte';

  let { modelFilename, onBack, onFinish } = $props<{
    modelFilename: string;
    onBack: () => void;
    onFinish: () => void;
  }>();

  let loading = $state(false);
  let loadError = $state('');
  let success = $state(false);

  async function loadAndFinish() {
    loading = true;
    loadError = '';
    try {
      // Find model path
      const models = await getLocalModels();
      const model = models.find(m => m.path.endsWith(modelFilename) || m.name === modelFilename);
      if (!model) throw new Error($t('onboarding.modelNotFound', { values: { filename: modelFilename } }));

      // Find runtime
      const runtimes = await getInstalledRuntimes();
      const runtimePath = (runtimes as any)?.runtimes?.[0]?.path || '';

      // Update store config to local mode with this model
      await appStore.setBackendMode('local');
      await appStore.updateLocalModel({
        id: model.id,
        name: model.name,
        source: 'local',
        path: model.path,
        details: model.size_label,
      });

      // Load model into runtime
      await loadLocalModel({
        config: appStore.config,
        modelPath: model.path,
        runtimePath,
        contextLength: 4096,
      });

      success = true;
      await markOnboardingComplete();
    } catch (err) {
      loadError = String((err as Error)?.message || err || $t('onboarding.loadModelFailed'));
    } finally {
      loading = false;
    }
  }

  async function handleFinish() {
    if (!success) {
      await loadAndFinish();
    }
    if (success) {
      onFinish();
    }
  }
</script>

<div class="flex flex-1 flex-col gap-5 px-6">
  <div class="flex items-center gap-2">
    <MessageSquare class="h-4 w-4 text-[var(--text-secondary)]" />
    <span class="text-sm font-medium text-[var(--text)]">{$t('onboarding.readyToChat')}</span>
  </div>

  {#if success}
    <div class="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <CheckCircle2 class="h-4 w-4 text-[var(--success)]" />
      <span>{$t('onboarding.modelLoadedReady')}</span>
    </div>
  {:else if loadError}
    <div class="space-y-2">
      <p class="text-sm text-[var(--error)]">{loadError}</p>
      <button
        class="text-xs underline hover:no-underline"
        onclick={loadAndFinish}
        disabled={loading}
      >
        {$t('chat.retry')}
      </button>
    </div>
  {:else}
    <p class="text-sm text-[var(--text-secondary)]">
      {$t('onboarding.readyDesc')}
    </p>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <LoaderCircle class="h-4 w-4 animate-spin" />
      <span>{$t('onboarding.loadingModel')}</span>
    </div>
  {/if}

  <div class="mt-auto flex items-center justify-between pt-4">
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)]"
      onclick={onBack}
      disabled={loading}
    >
      <ArrowLeft class="h-4 w-4" />
      {$t('onboarding.back')}
    </button>
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hover)] bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition hover:opacity-90 disabled:opacity-50"
      onclick={handleFinish}
      disabled={loading}
    >
      {#if success}
        {$t('onboarding.startChatting')}
      {:else}
        {$t('onboarding.loadModelAndChat')}
      {/if}
      <ArrowRight class="h-4 w-4" />
    </button>
  </div>
</div>
