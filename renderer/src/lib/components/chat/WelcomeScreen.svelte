<svelte:options runes={true} />

<script lang="ts">
  import { ArrowRight, Brain, LoaderCircle, Moon, Sparkles, Sun, Sunset, Zap } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { t } from 'svelte-i18n';

  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic',
    groq: 'Groq', mistral: 'Mistral', together: 'Together AI',
    deepseek: 'DeepSeek', cohere: 'Cohere', perplexity: 'Perplexity',
    lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom'
  };

  const activeModel = $derived(modelsStore.status?.active_model);
  const runtimeState = $derived(String(modelsStore.status?.state || ''));
  const isLoading = $derived(runtimeState === 'starting' || runtimeState === 'loading_model');

  const apiProviderLabel = $derived(
    appStore.backendMode === 'api'
      ? (PROVIDER_LABELS[appStore.activeProviderName] || appStore.activeProviderName)
      : null
  );
  const hasApiKey = $derived(!!appStore.activeProvider?.has_api_key);

  const modelName = $derived(
    activeModel
      ? activeModel.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? activeModel
      : ''
  );

  const showModelCards = $derived(
    appStore.backendMode === 'local' && !isLoading && !activeModel
  );

  const QUICK_MODELS = [
    {
      id: 'qwen3.5-0.8b',
      label: 'Qwen 3.5 0.8B',
      size: '~0.6 GB',
      icon: 'zap',
      tagline: 'Fastest start',
      useCase: 'Light prompts',
    },
    {
      id: 'qwen3.5-2b',
      label: 'Qwen 3.5 2B',
      size: '~1.5 GB',
      icon: 'sparkles',
      tagline: 'Balanced default',
      useCase: 'Daily chat',
    },
    {
      id: 'qwen3.5-4b',
      label: 'Qwen 3.5 4B',
      size: '~2.8 GB',
      icon: 'brain',
      tagline: 'Stronger reasoning',
      useCase: 'Analysis work',
    },
    {
      id: 'qwen3.5-9b',
      label: 'Qwen 3.5 9B',
      size: '~5.7 GB',
      icon: 'brain',
      tagline: 'Highest quality',
      useCase: 'Heavier tasks',
    },
  ];

  function getGreeting(): { text: string; icon: 'sun' | 'sunset' | 'moon' } {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return { text: $t('welcome.goodMorning'), icon: 'sun' };
    if (hour >= 12 && hour < 18) return { text: $t('welcome.goodAfternoon'), icon: 'sun' };
    if (hour >= 18 && hour < 21) return { text: $t('welcome.goodEvening'), icon: 'sunset' };
    return { text: $t('welcome.goodNight'), icon: 'moon' };
  }

  const greeting = $derived(getGreeting());

  function openModelHub(modelId?: string) {
    if (modelId) appStore.modelManagerOpenModelId = modelId;
    appStore.modelManagerOpen = true;
  }
</script>

<div class="flex h-full flex-col items-center justify-end pointer-events-none px-4 pb-8">
  <div class="pointer-events-auto text-center max-w-md">
    <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-secondary)]">
      {#if greeting.icon === 'sun'}
        <Sun class="h-5 w-5 text-[var(--text-secondary)]" />
      {:else if greeting.icon === 'sunset'}
        <Sunset class="h-5 w-5 text-[var(--text-secondary)]" />
      {:else}
        <Moon class="h-5 w-5 text-[var(--text-secondary)]" />
      {/if}
    </div>
    <h1 class="text-xl font-semibold tracking-tight text-[var(--text)]">
      {greeting.text}
    </h1>
    <p class="mt-1.5 text-sm text-[var(--text-muted)]">
      {#if isLoading}
        <span class="inline-flex items-center gap-1.5">
          <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
          Loading model...
        </span>
      {:else if activeModel}
        {modelName}
      {:else if appStore.backendMode === 'local'}
        No model loaded
      {:else if apiProviderLabel && hasApiKey}
        {apiProviderLabel}{appStore.activeModelLabel ? ` · ${appStore.activeModelLabel}` : ''}
      {:else}
        No model
      {/if}
    </p>

    {#if showModelCards}
      <div class="mt-6 w-full">
        <div class="mb-3 flex items-center justify-between gap-3 text-left">
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              Recommended local models
            </p>
            <p class="mt-1 text-sm text-[var(--text-secondary)]">
              Pick a starting point based on speed, memory, and response quality.
            </p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {#each QUICK_MODELS as m}
            <button
              type="button"
              class="openui-card openui-card-interactive group flex min-h-[122px] flex-col items-start gap-3 px-3 py-3 text-left"
              onclick={() => openModelHub(m.id)}
            >
              <div class="flex w-full items-start justify-between gap-2">
                <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--surface-highlight)] ring-1 ring-[var(--border-light)]">
                  {#if m.icon === 'zap'}
                    <Zap class="h-4 w-4 text-[var(--text-secondary)]" />
                  {:else if m.icon === 'sparkles'}
                    <Sparkles class="h-4 w-4 text-[var(--text-secondary)]" />
                  {:else}
                    <Brain class="h-4 w-4 text-[var(--text-secondary)]" />
                  {/if}
                </div>
                <span class="openui-muted-pill px-2 py-1 text-[10px] font-medium tracking-[0.02em] text-[var(--text-secondary)]">
                  {m.tagline}
                </span>
              </div>
              <div class="space-y-1">
                <p class="text-sm font-semibold tracking-[-0.01em] text-[var(--text)]">{m.label}</p>
                <p class="text-[11px] leading-5 text-[var(--text-muted)]">{m.useCase}</p>
              </div>
              <div class="mt-auto flex w-full items-center justify-between text-[11px] text-[var(--text-muted)]">
                <span>{m.size}</span>
                <span class="inline-flex items-center gap-1 text-[var(--text-secondary)] transition group-hover:text-[var(--text)]">
                  Open
                  <ArrowRight class="h-3 w-3" />
                </span>
              </div>
            </button>
          {/each}
        </div>
        <button
          type="button"
          class="mt-3 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] transition hover:text-[var(--text-secondary)]"
          onclick={() => openModelHub()}
        >
          Browse all models
          <ArrowRight class="h-3 w-3" />
        </button>
      </div>
    {:else if !isLoading && !activeModel && !(apiProviderLabel && hasApiKey)}
      <div class="mt-5">
        {#if appStore.backendMode === 'local'}
          <button
            class="openui-button-secondary inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--text-secondary)]"
            onclick={() => (appStore.modelManagerOpen = true)}
          >
            <Sparkles class="h-4 w-4 text-[var(--text-muted)]" />
            Download a model
            <ArrowRight class="h-3.5 w-3.5 opacity-50" />
          </button>
        {:else}
          <button
            class="openui-button-secondary inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--text-secondary)]"
            onclick={() => { appStore.modelManagerOpenSection = 'providers'; appStore.modelManagerOpen = true; }}
          >
            Configure a provider
            <ArrowRight class="h-3.5 w-3.5 opacity-50" />
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
