<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { MessageSquare, ArrowLeft, LoaderCircle, CheckCircle2, AlertTriangle } from 'lucide-svelte';
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

<div class="flex flex-1 flex-col gap-6 px-8">
  <div class="flex items-center gap-3">
    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--primary)]/10 text-[var(--primary)]">
      <MessageSquare class="h-5 w-5" />
    </div>
    <div>
      <h2 class="text-lg font-semibold text-[var(--text)]">{$t('onboarding.readyToChat')}</h2>
      <p class="text-sm text-[var(--text-secondary)]">
        {#if success}
          {$t('onboarding.modelLoadedSuccess')}
        {:else}
          {$t('onboarding.readyDesc')}
        {/if}
      </p>
    </div>
  </div>

  {#if success}
    <div class="flex items-center gap-3 rounded-xl border border-green-500/20 bg-green-500/5 px-4 py-3 text-sm text-green-400">
      <CheckCircle2 class="h-5 w-5 shrink-0" />
      <span>{$t('onboarding.modelLoadedReady')}</span>
    </div>
  {:else if loadError}
    <div class="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
      <AlertTriangle class="h-4 w-4 shrink-0 mt-0.5" />
      <div class="space-y-1">
        <span>{loadError}</span>
        <button
          class="text-xs underline hover:no-underline"
          onclick={loadAndFinish}
          disabled={loading}
        >
          {$t('chat.retry')}
        </button>
      </div>
    </div>
  {:else}
    <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p class="text-sm text-[var(--text-secondary)]">
        {$t('onboarding.readyHint')}
      </p>
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <LoaderCircle class="h-4 w-4 animate-spin" />
      <span>{$t('onboarding.loadingModel')}</span>
    </div>
  {/if}

  <div class="flex items-center justify-between pt-4">
    <button
      class="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--surface)]"
      onclick={onBack}
      disabled={loading}
    >
      <ArrowLeft class="h-4 w-4" />
      {$t('onboarding.back')}
    </button>
    <button
      class="inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
      onclick={handleFinish}
      disabled={loading}
    >
      {#if success}
        {$t('onboarding.startChatting')}
      {:else}
        {$t('onboarding.loadModelAndChat')}
      {/if}
      <MessageSquare class="h-4 w-4" />
    </button>
  </div>
</div>
