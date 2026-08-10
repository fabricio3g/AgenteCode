<svelte:options runes={true} />

<!--
  The "you can't send yet" line above the composer. One component covering the
  three mutually exclusive backend states, so the composer itself no longer
  carries three near-identical banner blocks.
-->

<script lang="ts">
  import { ArrowRight, LoaderCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { copy } from '$lib/copy';

  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
    groq: 'Groq',
    mistral: 'Mistral',
    together: 'Together AI',
    deepseek: 'DeepSeek',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    lmstudio: 'LM Studio',
    ollama: 'Ollama',
    custom: 'Custom'
  };

  const activeModel = $derived(modelsStore.status?.active_model);
  const runtimeState = $derived(String(modelsStore.status?.state || ''));
  const isModelLoading = $derived(runtimeState === 'starting' || runtimeState === 'loading_model');

  const providerLabel = $derived(
    appStore.backendMode === 'api'
      ? PROVIDER_LABELS[appStore.activeProviderName] || appStore.activeProviderName
      : null
  );
  const hasApiKey = $derived(
    !!appStore.activeProvider?.has_api_key || !!appStore.activeProvider?.api_key
  );

  const state = $derived.by((): 'loading' | 'no-local-model' | 'no-provider' | 'ready' => {
    if (isModelLoading) return 'loading';
    if (appStore.backendMode === 'local' && !activeModel && !appStore.localModelActive) {
      return 'no-local-model';
    }
    if (appStore.backendMode === 'api' && !(providerLabel && hasApiKey)) return 'no-provider';
    return 'ready';
  });

  function openModelHub(section: string) {
    appStore.modelManagerOpenSection = section;
    appStore.modelManagerOpen = true;
  }
</script>

{#if state === 'loading'}
  <div class="notice pointer-events-auto justify-center">
    <p class="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle class="size-3.5 animate-spin" />
      {copy.model.loading}
    </p>
  </div>
{:else if state === 'no-local-model'}
  <div class="notice pointer-events-auto flex-wrap justify-center gap-2">
    <p class="text-xs text-muted-foreground">{copy.model.none}</p>
    <button
      type="button"
      class="notice-btn primary"
      onclick={() => openModelHub('explore')}
    >
      {copy.model.browseAll}
      <ArrowRight class="size-3" />
    </button>
    <button type="button" class="notice-btn" onclick={() => openModelHub('runtime')}>
      {copy.model.changeRuntime}
    </button>
  </div>
{:else if state === 'no-provider'}
  <div class="notice pointer-events-auto justify-center">
    <p class="text-xs text-muted-foreground">
      {copy.model.none}
      <button type="button" class="notice-link" onclick={() => openModelHub('providers')}>
        {copy.model.configureProvider}
        <ArrowRight class="size-3" />
      </button>
    </p>
  </div>
{/if}

<style>
  .notice {
    display: flex;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .notice-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--foreground);
    box-shadow: var(--surface-shadow);
    font-size: 0.7rem;
    font-weight: 500;
    transition:
      background-color 150ms ease,
      opacity 150ms ease,
      transform 150ms var(--motion-ease);
  }

  .notice-btn:hover {
    background: var(--muted);
  }

  .notice-btn:active {
    transform: scale(0.97);
  }

  .notice-btn.primary {
    border-color: transparent;
    background: var(--primary);
    color: var(--primary-foreground);
    font-weight: 600;
  }

  .notice-btn.primary:hover {
    opacity: 0.9;
  }

  .notice-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: 0.25rem;
    color: var(--muted-foreground);
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 2px;
    transition: color 150ms ease;
  }

  .notice-link:hover {
    color: var(--foreground);
  }
</style>
