<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import SearchSettings from './SearchSettings.svelte';
  import { StatusIndicator } from '$lib/components/ui';
  import { t } from 'svelte-i18n';
  import SettingsPage from './SettingsPage.svelte';
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
  let hfToken = $state('');

  let searchProvider = $state(appStore.config.search?.provider || 'aggregator');
  let persistedSearchProvider = $state(appStore.config.search?.provider || 'aggregator');
  let searchApiKey = $state('');
  // One field edits the base URL of whichever provider takes one; each keeps
  // its own saved value and default (the connectors' defaults).
  const DEFAULT_BASE_URLS: Record<string, string> = {
    searxng: 'https://searx.org',
    jina: 'https://s.jina.ai',
  };
  function storedBaseUrl(provider: string): string {
    const providers = (appStore.config.search?.providers || {}) as Record<string, { base_url?: string }>;
    return providers[provider]?.base_url || DEFAULT_BASE_URLS[provider] || '';
  }
  let searchBaseUrl = $state(storedBaseUrl(appStore.config.search?.provider || 'aggregator') || DEFAULT_BASE_URLS.searxng);
  let searchModel = $state(appStore.config.search?.providers?.perplexity?.model || 'sonar');
  let searchApiUrl = $state(appStore.config.search?.providers?.perplexity?.api_url || 'https://api.perplexity.ai');
  let aggregatorEngines = $state<string[]>([
    ...(appStore.config.search?.aggregator_engines || ['wikipedia', 'arxiv', 'crossref', 'pubmed'])
  ]);
  let searchSafeSearch = $state(String(appStore.config.search?.safe_search ?? 2));
  let aggregatorProviders = $state<Record<string, Record<string, unknown>>>(
    // `appStore.config` is a $state proxy; structuredClone refuses proxies and
    // throws in Electron (where config has data). $state.snapshot deep-clones it
    // into a plain object first.
    $state.snapshot((appStore.config.search?.providers || {}) as Record<string, Record<string, unknown>>)
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
  };

  type SearchPreferences = {
    provider: string;
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

  // Baselines are captured once; later comparisons happen in effects.
  let previousGeneralSignature = JSON.stringify(untrack(() => ({
    showAssistantText,
    enableThinking,
  })));
  let previousSearchSignature = JSON.stringify(untrack(() => ({
    searchProvider,
    aggregatorEngines,
    searchSafeSearch,
  })));

  const providersRequiringConfiguration = new Set([
    'searxng', 'brave', 'tavily', 'exa', 'perplexity', 'jina', 'youcom',
  ]);

  function getStoredSearchApiKey(provider: string): string {
    const providers = appStore.config.search?.providers || {};
    switch (provider) {
      case 'brave': return providers.brave?.api_key || '';
      case 'tavily': return providers.tavily?.api_key || '';
      case 'exa': return providers.exa?.api_key || '';
      case 'searxng': return providers.searxng?.base_url || '';
      case 'jina': return providers.jina?.api_key || '';
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

  function currentSearchPreferences(): SearchPreferences {
    const canActivateProvider = providerHasConfiguration(searchProvider);
    return {
      provider: canActivateProvider ? searchProvider : persistedSearchProvider,
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
    if (provider in DEFAULT_BASE_URLS) searchBaseUrl = untrack(() => storedBaseUrl(provider));
  });

  $effect(() => {
    const signature = JSON.stringify({ showAssistantText, enableThinking });
    if (!mounted || signature === previousGeneralSignature) return;
    previousGeneralSignature = signature;
    generalAutosave.schedule({
      show_assistant_text: showAssistantText,
      enable_thinking: enableThinking,
    });
  });

  $effect(() => {
    const signature = JSON.stringify({ searchProvider, aggregatorEngines, searchSafeSearch });
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
      // A debounced preference write captured the previous provider (an
      // unconfigured one cannot be activated by autosave); drop it so it
      // cannot land after this save and switch the provider back.
      await searchAutosave.cancel();
      await appStore.updateSearchSettings({
        provider: searchProvider,
        aggregator_engines: aggregatorEngines,
        safe_search: Number(searchSafeSearch),
        providers: {
          ...aggregatorProviders,
          ...(searchProvider === 'brave' ? { brave: { api_key: searchApiKey || appStore.config.search?.providers?.brave?.api_key } } : {}),
          ...(searchProvider === 'tavily' ? { tavily: { api_key: searchApiKey || appStore.config.search?.providers?.tavily?.api_key } } : {}),
          ...(searchProvider === 'exa' ? { exa: { api_key: searchApiKey || appStore.config.search?.providers?.exa?.api_key } } : {}),
          ...(searchProvider === 'searxng'
            ? { searxng: { base_url: searchBaseUrl || appStore.config.search?.providers?.searxng?.base_url || 'https://searx.org' } }
            : {}),
          ...(searchProvider === 'jina'
            ? { jina: { api_key: searchApiKey || appStore.config.search?.providers?.jina?.api_key, base_url: searchBaseUrl || storedBaseUrl('jina') } }
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

<SettingsPage
  title={activeTab === 'General' ? $t('generalSettings.title') : $t('searchSettings.title')}
  description={activeTab === 'General' ? $t('generalSettings.description') : $t('searchSettings.description')}
>
    {#snippet actions()}
      {#if activeTab === 'General'}
        <StatusIndicator state={generalStatus} message={generalStatusMessage} onretry={generalAutosave.retry} />
      {:else}
        <StatusIndicator state={searchStatus} message={searchStatusMessage} onretry={searchAutosave.retry} />
      {/if}
    {/snippet}

    {#if activeTab === 'General'}
      <GeneralSettings
        bind:enableThinking
        bind:hfToken
        onsaveHfToken={saveHfToken}
      />
    {:else}
      <SearchSettings
        bind:searchProvider
        bind:searchApiKey
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
</SettingsPage>
