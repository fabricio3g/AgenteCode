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
  import { providerLabel as providerName } from '$lib/utils/providers';


  const activeModel = $derived(modelsStore.status?.active_model);
  const runtimeState = $derived(String(modelsStore.status?.state || ''));
  const isModelLoading = $derived(runtimeState === 'starting' || runtimeState === 'loading_model');

  const providerLabel = $derived(
    appStore.backendMode === 'api'
      ? providerName(appStore.activeProviderName)
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
    appStore.openSettings(section);
  }
</script>

{#if state === 'loading'}
  <div class="notice pointer-events-auto justify-center">
    <p class="notice-label inline-flex items-center gap-2">
      <LoaderCircle class="size-3.5 animate-spin" />
      {copy.model.loading}
    </p>
  </div>
{:else if state === 'no-local-model'}
  <div class="notice notice-empty pointer-events-auto">
    <p class="notice-label notice-empty-label">{copy.model.none}</p>
    <div class="notice-actions">
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
  </div>
{:else if state === 'no-provider'}
  <div class="notice pointer-events-auto justify-center">
    <p class="notice-label">
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
    margin-bottom: 0.625rem;
  }

  .notice-label {
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.005em;
  }
  .notice-empty { flex-direction: column; justify-content: center; gap: 0.5rem; }
  .notice-empty-label { font-size: var(--text-xs); font-weight: 400; color: var(--muted-foreground); }
  .notice-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0.5rem; }

  /* Pill buttons sized to sit level with the composer's own controls. Both
     actions carry the same visual weight — a solid black button next to a
     hairline one read as a warning rather than a choice. */
  .notice-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 1.875rem;
    padding: 0.3125rem 0.8125rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--foreground);
    box-shadow: var(--surface-shadow);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: -0.005em;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      transform 150ms var(--motion-ease);
  }

  .notice-btn:hover {
    border-color: var(--border-hover, var(--border));
    background: var(--muted);
  }

  .notice-btn:active {
    transform: scale(0.97);
  }

  .notice-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
  }

  /* The recommended path stays distinguishable by weight, not by inverting
     into a heavy black slab. */
  .notice-btn.primary {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: var(--card);
    font-weight: 600;
  }

  .notice-btn.primary:hover {
    border-color: color-mix(in srgb, var(--foreground) 38%, transparent);
    background: var(--muted);
  }

  .notice-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: 0.25rem;
    color: var(--text-secondary);
    font-weight: 500;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--foreground) 30%, transparent);
    text-underline-offset: 2px;
    transition: color 150ms ease;
  }

  .notice-link:hover {
    color: var(--foreground);
  }

  .notice-link:focus-visible {
    outline: none;
    color: var(--foreground);
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
    border-radius: var(--radius-sm);
  }
</style>
