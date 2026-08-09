<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import SearchSettings from './SearchSettings.svelte';
  import { StatusIndicator } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import {
    createAutosaveController,
    type AutosaveSnapshot,
    type AutosaveState,
  } from '$lib/utils/autosave';

  type Tab = 'General' | 'Search';

  let { activeTab = 'General' }: { activeTab?: Tab } = $props();

  let showAssistantText = $state(appStore.config.ui?.show_assistant_text ?? true);
  let enableThinking = $state(appStore.config.ui?.enable_thinking ?? true);
  let composerModeControl = $state<'tabs' | 'auto'>(
    appStore.config.ui?.composer_mode_control === 'tabs' ? 'tabs' : 'auto'
  );
  let hfToken = $state('');

  let searchProvider = $state(appStore.config.search?.provider || 'aggregator');
  let persistedSearchProvider = $state(appStore.config.search?.provider || 'aggregator');
  let searchMaxResults = $state(String(appStore.config.search?.max_results ?? 6));
  let searchApiKey = $state('');
  let searchEngineId = $state(appStore.config.search?.providers?.google_cse?.engine_id || '');
  let searchBaseUrl = $state(appStore.config.search?.providers?.searxng?.base_url || 'https://searx.org');
  let searchModel = $state(appStore.config.search?.providers?.perplexity?.model || 'sonar');
  let searchApiUrl = $state(appStore.config.search?.providers?.perplexity?.api_url || 'https://api.perplexity.ai');
  let aggregatorEngines = $state<string[]>([
    ...(appStore.config.search?.aggregator_engines || ['duckduckgo', 'wikipedia', 'wiby', 'mojeek'])
  ]);
  let searchSafeSearch = $state(String(appStore.config.search?.safe_search ?? 2));
  let aggregatorProviders = $state<Record<string, Record<string, unknown>>>(
    structuredClone((appStore.config.search?.providers || {}) as Record<string, Record<string, unknown>>)
  );

  let generalStatus = $state<AutosaveState>('idle');
  let generalStatusMessage = $state('');
  let searchStatus = $state<AutosaveState>('idle');
  let searchStatusMessage = $state('');
  let savingSearchConfiguration = $state(false);
  let mounted = $state(false);

  type GeneralPreferences = {
    show_assistant_text: boolean;
    enable_thinking: boolean;
    composer_mode_control: 'tabs' | 'auto';
  };

  type SearchPreferences = {
    provider: string;
    max_results: number;
    aggregator_engines: string[];
    safe_search: number;
  };

  function applyGeneralState(snapshot: AutosaveSnapshot<GeneralPreferences>) {
    generalStatus = snapshot.state;
    generalStatusMessage = snapshot.error || '';
  }

  function applySearchState(snapshot: AutosaveSnapshot<SearchPreferences>) {
    searchStatus = snapshot.state;
    searchStatusMessage = snapshot.error || '';
  }

  const generalAutosave = createAutosaveController<GeneralPreferences>(
    (value) => appStore.updateUiSettings(value),
    applyGeneralState,
  );

  const searchAutosave = createAutosaveController<SearchPreferences>(
    async (value) => {
      await appStore.updateSearchSettings(value);
      persistedSearchProvider = value.provider;
    },
    applySearchState,
  );

  let previousGeneralSignature = JSON.stringify({
    showAssistantText,
    enableThinking,
    composerModeControl,
  });
  let previousSearchSignature = JSON.stringify({
    searchProvider,
    searchMaxResults,
    aggregatorEngines,
    searchSafeSearch,
  });

  const providersRequiringConfiguration = new Set([
    'searxng', 'brave', 'google_cse', 'tavily', 'exa', 'serpapi',
    'serper', 'perplexity', 'jina', 'bing', 'youcom',
  ]);

  function getStoredSearchApiKey(provider: string): string {
    const providers = appStore.config.search?.providers || {};
    switch (provider) {
      case 'google_cse': return providers.google_cse?.api_key || '';
      case 'brave': return providers.brave?.api_key || '';
      case 'serpapi': return providers.serpapi?.api_key || '';
      case 'serper': return providers.serper?.api_key || '';
      case 'tavily': return providers.tavily?.api_key || '';
      case 'exa': return providers.exa?.api_key || '';
      case 'searxng': return providers.searxng?.base_url || '';
      case 'jina': return providers.jina?.api_key || '';
      case 'bing': return providers.bing?.api_key || '';
      case 'perplexity': return providers.perplexity?.api_key || '';
      case 'youcom': return providers.youcom?.api_key || '';
      default: return '';
    }
  }

  function providerHasConfiguration(provider: string): boolean {
    if (!providersRequiringConfiguration.has(provider)) return true;
    const stored = getStoredSearchApiKey(provider);
    if (stored.trim()) return true;
    if (provider === 'searxng') return searchBaseUrl.trim().length > 0;
    return searchApiKey.trim().length > 0;
  }

  function normalizedMaxResults(): number {
    const parsed = Number(searchMaxResults);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.round(parsed), 20)) : 6;
  }

  function currentSearchPreferences(): SearchPreferences {
    const canActivateProvider = providerHasConfiguration(searchProvider);
    return {
      provider: canActivateProvider ? searchProvider : persistedSearchProvider,
      max_results: normalizedMaxResults(),
      aggregator_engines: [...aggregatorEngines],
      safe_search: Number(searchSafeSearch),
    };
  }

  onMount(() => {
    hfToken = localStorage.getItem('chatealm_hf_token') || '';
    searchApiKey = getStoredSearchApiKey(searchProvider);
    mounted = true;
  });

  onDestroy(() => {
    generalAutosave.dispose();
    searchAutosave.dispose();
  });

  $effect(() => {
    const provider = String(searchProvider || 'auto').toLowerCase();
    searchApiKey = getStoredSearchApiKey(provider);
  });

  $effect(() => {
    const signature = JSON.stringify({ showAssistantText, enableThinking, composerModeControl });
    if (!mounted || signature === previousGeneralSignature) return;
    previousGeneralSignature = signature;
    generalAutosave.schedule({
      show_assistant_text: showAssistantText,
      enable_thinking: enableThinking,
      composer_mode_control: composerModeControl,
    });
  });

  $effect(() => {
    const signature = JSON.stringify({ searchProvider, searchMaxResults, aggregatorEngines, searchSafeSearch });
    if (!mounted || signature === previousSearchSignature) return;
    previousSearchSignature = signature;

    if (searchProvider === 'aggregator' && aggregatorEngines.length === 0) {
      searchAutosave.block('Enable at least one engine to save this pool.', currentSearchPreferences());
      return;
    }

    const preferences = currentSearchPreferences();
    searchAutosave.schedule(preferences);
    if (!providerHasConfiguration(searchProvider)) {
      searchStatus = 'blocked';
      searchStatusMessage = 'Configure this provider, then choose Save and use.';
    }
  });

  function saveHfToken() {
    const token = hfToken.trim();
    if (token) localStorage.setItem('chatealm_hf_token', token);
    else localStorage.removeItem('chatealm_hf_token');
    toastStore.success('Hugging Face token saved');
  }

  async function saveSearchConfiguration() {
    if (searchProvider === 'aggregator' && aggregatorEngines.length === 0) {
      searchStatus = 'blocked';
      searchStatusMessage = 'Enable at least one engine before saving configuration.';
      return;
    }
    savingSearchConfiguration = true;
    try {
      await appStore.updateSearchSettings({
        provider: searchProvider,
        max_results: normalizedMaxResults(),
        aggregator_engines: aggregatorEngines,
        safe_search: Number(searchSafeSearch),
        providers: {
          ...aggregatorProviders,
          ...(searchProvider === 'google_cse'
            ? { google_cse: { api_key: searchApiKey || appStore.config.search?.providers?.google_cse?.api_key, engine_id: searchEngineId || appStore.config.search?.providers?.google_cse?.engine_id } }
            : {}),
          ...(searchProvider === 'brave' ? { brave: { api_key: searchApiKey || appStore.config.search?.providers?.brave?.api_key } } : {}),
          ...(searchProvider === 'serpapi' ? { serpapi: { api_key: searchApiKey || appStore.config.search?.providers?.serpapi?.api_key } } : {}),
          ...(searchProvider === 'serper' ? { serper: { api_key: searchApiKey || appStore.config.search?.providers?.serper?.api_key } } : {}),
          ...(searchProvider === 'tavily' ? { tavily: { api_key: searchApiKey || appStore.config.search?.providers?.tavily?.api_key } } : {}),
          ...(searchProvider === 'exa' ? { exa: { api_key: searchApiKey || appStore.config.search?.providers?.exa?.api_key } } : {}),
          ...(searchProvider === 'searxng'
            ? { searxng: { base_url: searchBaseUrl || appStore.config.search?.providers?.searxng?.base_url || 'https://searx.org' } }
            : {}),
          ...(searchProvider === 'jina'
            ? { jina: { api_key: searchApiKey || appStore.config.search?.providers?.jina?.api_key, base_url: searchBaseUrl || appStore.config.search?.providers?.jina?.base_url || 'https://api.jina.ai' } }
            : {}),
          ...(searchProvider === 'bing'
            ? { bing: { api_key: searchApiKey || appStore.config.search?.providers?.bing?.api_key, endpoint: searchBaseUrl || appStore.config.search?.providers?.bing?.endpoint || 'https://api.bing.microsoft.com/v7.0/search' } }
            : {}),
          ...(searchProvider === 'perplexity'
            ? { perplexity: { api_key: searchApiKey || appStore.config.search?.providers?.perplexity?.api_key, model: searchModel || appStore.config.search?.providers?.perplexity?.model || 'sonar', api_url: searchApiUrl || appStore.config.search?.providers?.perplexity?.api_url || 'https://api.perplexity.ai' } }
            : {}),
          ...(searchProvider === 'youcom' ? { youcom: { api_key: searchApiKey || appStore.config.search?.providers?.youcom?.api_key } } : {}),
        },
      });
      persistedSearchProvider = searchProvider;
      searchStatus = 'saved';
      searchStatusMessage = '';
    } catch (error) {
      searchStatus = 'error';
      searchStatusMessage = error instanceof Error ? error.message : 'Could not save search configuration';
    } finally {
      savingSearchConfiguration = false;
    }
  }
</script>

<section class="min-h-0 flex-1 overflow-y-auto bg-background">
  <div class="mx-auto flex w-full max-w-[760px] flex-col px-4 py-5 sm:px-6 sm:py-6">
    <div class="mb-2 flex min-h-7 justify-end">
      {#if activeTab === 'General'}
        <StatusIndicator state={generalStatus} message={generalStatusMessage} onretry={generalAutosave.retry} />
      {:else}
        <StatusIndicator state={searchStatus} message={searchStatusMessage} onretry={searchAutosave.retry} />
      {/if}
    </div>

    {#if activeTab === 'General'}
      <GeneralSettings
        bind:showAssistantText
        bind:enableThinking
        bind:composerModeControl
        bind:hfToken
        onsaveHfToken={saveHfToken}
      />
    {:else}
      <SearchSettings
        bind:searchProvider
        bind:searchMaxResults
        bind:searchApiKey
        bind:searchEngineId
        bind:searchBaseUrl
        bind:searchModel
        bind:searchApiUrl
        bind:aggregatorEngines
        bind:searchSafeSearch
        bind:aggregatorProviders
        onSaveConfiguration={saveSearchConfiguration}
        savingConfiguration={savingSearchConfiguration}
      />
    {/if}
  </div>
</section>
