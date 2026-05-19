<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { Settings, Search, MonitorCheck, Sparkles } from 'lucide-svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import SearchSettings from './SearchSettings.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';

  type Tab = 'General' | 'Search' | 'Hardware';

  let activeTab = $state<Tab>('General');

  let showAssistantText = $state(appStore.config.ui?.show_assistant_text ?? true);
  let enableThinking = $state(appStore.config.ui?.enable_thinking ?? true);
  let hfToken = $state('');

  let searchProvider = $state(appStore.config.search?.provider || 'auto');
  let searchMaxResults = $state(String(appStore.config.search?.max_results ?? 6));
  let searchApiKey = $state('');
  let searchEngineId = $state(appStore.config.search?.providers?.google_cse?.engine_id || '');
  let searchBaseUrl = $state(appStore.config.search?.providers?.searxng?.base_url || 'https://searx.org');
  let searchModel = $state(appStore.config.search?.providers?.perplexity?.model || 'sonar');
  let searchApiUrl = $state(appStore.config.search?.providers?.perplexity?.api_url || 'https://api.perplexity.ai');

  let savingGeneral = $state(false);
  let savingSearch = $state(false);

  function getStoredSearchApiKey(provider: string): string {
    const providers = appStore.config.search?.providers || {};
    switch (provider) {
      case 'google_cse':
        return providers.google_cse?.api_key || '';
      case 'brave':
        return providers.brave?.api_key || '';
      case 'serpapi':
        return providers.serpapi?.api_key || '';
      case 'serper':
        return providers.serper?.api_key || '';
      case 'tavily':
        return providers.tavily?.api_key || '';
      case 'exa':
        return providers.exa?.api_key || '';
      case 'searxng':
        return providers.searxng?.base_url || 'https://searx.org';
      case 'jina':
        return providers.jina?.api_key || '';
      case 'bing':
        return providers.bing?.api_key || '';
      case 'perplexity':
        return providers.perplexity?.api_key || '';
      case 'youcom':
        return providers.youcom?.api_key || '';
      default:
        return '';
    }
  }

  onMount(() => {
    hfToken = localStorage.getItem('chatealm_hf_token') || '';
    const provider = String(searchProvider || 'auto').toLowerCase();
    searchApiKey = getStoredSearchApiKey(provider);
  });

  $effect(() => {
    const provider = String(searchProvider || 'auto').toLowerCase();
    searchApiKey = getStoredSearchApiKey(provider);
  });

  function saveHfToken() {
    const token = hfToken.trim();
    if (token) localStorage.setItem('chatealm_hf_token', token);
    else localStorage.removeItem('chatealm_hf_token');
  }

  async function saveGeneralSettings() {
    savingGeneral = true;
    await appStore.updateUiSettings({
      show_assistant_text: showAssistantText,
      enable_thinking: enableThinking
    });
    saveHfToken();
    savingGeneral = false;
    toastStore.success('Settings saved');
  }

  async function saveSearchSettings() {
    savingSearch = true;
    await appStore.updateSearchSettings({
      provider: searchProvider,
      max_results: searchMaxResults ? Number(searchMaxResults) : undefined,
      providers: {
        ...(searchProvider === 'google_cse'
          ? { google_cse: { api_key: searchApiKey || appStore.config.search?.providers?.google_cse?.api_key, engine_id: searchEngineId || appStore.config.search?.providers?.google_cse?.engine_id } }
          : {}),
        ...(searchProvider === 'brave'
          ? { brave: { api_key: searchApiKey || appStore.config.search?.providers?.brave?.api_key } }
          : {}),
        ...(searchProvider === 'serpapi'
          ? { serpapi: { api_key: searchApiKey || appStore.config.search?.providers?.serpapi?.api_key } }
          : {}),
        ...(searchProvider === 'serper'
          ? { serper: { api_key: searchApiKey || appStore.config.search?.providers?.serper?.api_key } }
          : {}),
        ...(searchProvider === 'tavily'
          ? { tavily: { api_key: searchApiKey || appStore.config.search?.providers?.tavily?.api_key } }
          : {}),
        ...(searchProvider === 'exa'
          ? { exa: { api_key: searchApiKey || appStore.config.search?.providers?.exa?.api_key } }
          : {}),
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
        ...(searchProvider === 'youcom'
          ? { youcom: { api_key: searchApiKey || appStore.config.search?.providers?.youcom?.api_key } }
          : {})
      }
    });
    savingSearch = false;
    toastStore.success('Search settings saved');
  }
</script>

<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
  <div class="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-5 py-2.5">
    <div class="chateaui-segmented">
      {#each [
        { id: 'General', label: 'General', icon: Settings },
        { id: 'Search', label: 'Search', icon: Search },
        { id: 'Hardware', label: 'Hardware', icon: MonitorCheck },
      ] as tab}
        <button
          type="button"
          class="chateaui-segment inline-flex items-center gap-1.5 {activeTab === tab.id ? 'is-active' : ''}"
          onclick={() => {
            activeTab = tab.id as Tab;
            if (tab.id === 'Hardware') void hardwareStore.refresh();
          }}
        >
          <tab.icon class="h-3.5 w-3.5" />
          <span>{tab.label}</span>
        </button>
      {/each}
    </div>

    <button
      type="button"
      class="chateaui-icon-button h-7 w-7 p-0"
      onclick={() => { appStore.modelManagerOpen = false; appStore.onboardingOpen = true; }}
      title="Re-run Setup"
    >
      <Sparkles class="h-3.5 w-3.5" />
    </button>
  </div>

  {#if activeTab === 'General'}
    <div class="flex-1 overflow-y-auto p-5">
      <GeneralSettings
        bind:showAssistantText
        bind:enableThinking
        bind:hfToken
        onsaveHfToken={saveHfToken}
      />
      <div class="mt-5 flex items-center justify-end border-t border-[var(--border)] pt-4">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
          onclick={saveGeneralSettings}
          disabled={savingGeneral}
        >
          {savingGeneral ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  {/if}

  {#if activeTab === 'Search'}
    <div class="flex-1 overflow-y-auto p-5">
      <SearchSettings
        bind:searchProvider
        bind:searchMaxResults
        bind:searchApiKey
        bind:searchEngineId
        bind:searchBaseUrl
        bind:searchModel
      />
      <div class="mt-5 flex items-center justify-end border-t border-[var(--border)] pt-4">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--primary-fg)] transition hover:opacity-90 disabled:opacity-50"
          onclick={saveSearchSettings}
          disabled={savingSearch}
        >
          {savingSearch ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  {/if}

  {#if activeTab === 'Hardware'}
    <div class="flex-1 overflow-y-auto p-5">
      <VoiceSettings />
    </div>
  {/if}
</div>
