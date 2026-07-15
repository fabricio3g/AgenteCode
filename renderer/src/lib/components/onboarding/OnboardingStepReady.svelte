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
    <MessageSquare class="size-4 text-muted-foreground" />
    <span class="text-sm font-medium text-foreground">{$t('onboarding.readyToChat')}</span>
  </div>

  {#if success}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <CheckCircle2 class="size-4 text-success" />
      <span>{$t('onboarding.modelLoadedReady')}</span>
    </div>
  {:else if loadError}
    <div class="space-y-2">
      <p class="text-sm text-error">{loadError}</p>
      <button
        type="button"
        class="text-xs underline hover:no-underline"
        onclick={loadAndFinish}
        disabled={loading}
      >
        {$t('chat.retry')}
      </button>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">
      {$t('onboarding.readyDesc')}
    </p>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle class="size-4 animate-spin" />
      <span>{$t('onboarding.loadingModel')}</span>
    </div>
  {/if}

  <div class="mt-auto flex items-center justify-between pt-4">
    <button
      type="button"
      class="aui-btn aui-btn-ghost gap-1.5 px-4"
      onclick={onBack}
      disabled={loading}
    >
      <ArrowLeft class="size-4" />
      {$t('onboarding.back')}
    </button>
    <button
      type="button"
      class="aui-btn aui-btn-primary px-5 disabled:opacity-50"
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
