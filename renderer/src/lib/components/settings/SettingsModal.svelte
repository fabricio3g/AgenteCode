<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { X, Settings, Cpu, Search, MonitorCheck, Sparkles } from 'lucide-svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import SearchSettings from './SearchSettings.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { t } from 'svelte-i18n';

  type Tab = 'General' | 'Search' | 'Runtime' | 'Hardware';

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
  let searchEndpoint = $state(appStore.config.search?.providers?.bing?.endpoint || 'https://api.bing.microsoft.com/v7.0/search');

  let saving = $state(false);

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
    hfToken = localStorage.getItem('talamolm_hf_token') || '';
    const provider = String(searchProvider || 'auto').toLowerCase();
    searchApiKey = getStoredSearchApiKey(provider);
  });

  $effect(() => {
    const provider = String(searchProvider || 'auto').toLowerCase();
    searchApiKey = getStoredSearchApiKey(provider);
  });

  function saveHfToken() {
    const token = hfToken.trim();
    if (token) localStorage.setItem('talamolm_hf_token', token);
    else localStorage.removeItem('talamolm_hf_token');
  }

  async function save() {
    saving = true;

    await appStore.updateUiSettings({
      show_assistant_text: showAssistantText,
      enable_thinking: enableThinking
    });
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
    saveHfToken();

    saving = false;
    appStore.settingsOpen = false;
  }
</script>

<div class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-4" role="dialog" aria-modal="true" transition:fade={{ duration: 150 }}>
  <div class="modal-surface flex h-[min(680px,calc(100vh-3rem))] w-full max-w-4xl overflow-hidden" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}>
    <!-- Sidebar -->
    <div class="modal-sidebar flex w-60 flex-col">
      <div class="px-5 py-5">
        <h2 class="sidebar-title text-sm font-semibold">{$t('settings.title')}</h2>
      </div>
      <nav class="nav-list flex-1 space-y-1 overflow-y-auto px-3">
        <button class={`nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${activeTab === 'General' ? 'is-active' : ''}`} onclick={() => activeTab = 'General'}>
          <Settings class="h-4 w-4" />
          {$t('settings.general')}
        </button>
        <button class={`nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${activeTab === 'Search' ? 'is-active' : ''}`} onclick={() => activeTab = 'Search'}>
          <Search class="h-4 w-4" />
          {$t('settings.search')}
        </button>
        <div class="nav-divider my-2"></div>
        <button class={`nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${activeTab === 'Runtime' ? 'is-active' : ''}`} onclick={() => activeTab = 'Runtime'}>
          <Cpu class="h-4 w-4" />
          {$t('settings.runtime')}
        </button>
        <button class={`nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${activeTab === 'Hardware' ? 'is-active' : ''}`} onclick={() => { activeTab = 'Hardware'; void hardwareStore.refresh(); }}>
          <MonitorCheck class="h-4 w-4" />
          {$t('settings.hardware')}
        </button>
        <div class="nav-divider my-2"></div>
        <button
          class="nav-item flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition"
          onclick={() => { appStore.settingsOpen = false; appStore.onboardingOpen = true; }}
        >
          <Sparkles class="h-4 w-4" />
          {$t('settings.rerunSetup')}
        </button>
      </nav>
    </div>

    <!-- Main content -->
    <div class="modal-main flex min-w-0 flex-1 flex-col">
      <div class="modal-header flex items-center justify-between px-6 py-4">
        <h2 class="modal-heading text-lg font-semibold">{activeTab}</h2>
        <button class="close-btn flex h-9 w-9 items-center justify-center rounded-xl" aria-label={$t('settings.close')} onclick={() => (appStore.settingsOpen = false)}>
          <X class="h-4 w-4" />
        </button>
      </div>

      <div class="modal-body flex-1 overflow-y-auto p-6">
        {#if activeTab === 'General'}
          <GeneralSettings
            bind:showAssistantText
            bind:enableThinking
            bind:hfToken
            onsaveHfToken={saveHfToken}
          />
        {/if}

        {#if activeTab === 'Search'}
          <SearchSettings
            bind:searchProvider
            bind:searchMaxResults
            bind:searchApiKey
            bind:searchEngineId
            bind:searchBaseUrl
            bind:searchModel
          />
        {/if}

        {#if activeTab === 'Hardware'}
          <VoiceSettings />
        {/if}


        {#if activeTab === 'Runtime'}
          <div class="space-y-4">
            <div class="info-card rounded-xl p-4">
              <div class="text-sm font-medium">{$t('settings.runtimeMoved')}</div>
              <div class="mt-1 text-xs text-[var(--text-muted)]">{$t('settings.runtimeMovedDesc')}</div>
            </div>
            <button class="primary-btn rounded-xl px-4 py-2.5 text-sm font-medium" onclick={() => { appStore.settingsOpen = false; appStore.runtimeManagerOpen = true; }}>
              {$t('settings.openRuntime')}
            </button>
          </div>
        {/if}
      </div>

      <div class="modal-footer flex items-center justify-end gap-2 px-6 py-4">
        <button class="btn secondary rounded-xl px-4 py-2 text-sm font-medium" onclick={() => (appStore.settingsOpen = false)}>
          {$t('settings.cancel')}
        </button>
        <button class="btn primary rounded-xl px-4 py-2 text-sm font-medium" onclick={save} disabled={saving}>
          {saving ? $t('settings.saving') : $t('settings.save')}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-surface {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 1.25rem;
    box-shadow: var(--shadow-xl);
  }

  .modal-sidebar {
    background: var(--surface-highlight);
    border-right: 1px solid var(--border);
  }

  .sidebar-title {
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .nav-item {
    color: var(--text-secondary);
  }

  .nav-item:hover {
    color: var(--text);
    background: var(--surface);
  }

  .nav-item.is-active {
    color: var(--text);
    background: var(--surface);
    font-weight: 500;
  }

  .nav-divider {
    border-top: 1px solid var(--border);
  }

  .modal-header {
    border-bottom: 1px solid var(--border);
  }

  .modal-heading {
    color: var(--text);
  }

  .close-btn {
    color: var(--text-muted);
    transition: color 0.12s, background 0.12s;
  }

  .close-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .info-card {
    background: var(--surface-highlight);
    border: 1px solid var(--border);
    color: var(--text);
  }

  .primary-btn {
    background: var(--primary);
    color: var(--primary-fg);
    transition: opacity 0.12s;
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .modal-footer {
    border-top: 1px solid var(--border);
  }

  .btn {
    transition: all 0.12s;
  }

  .btn.secondary {
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
  }

  .btn.secondary:hover {
    color: var(--text);
    background: var(--surface-highlight);
    border-color: var(--border-strong);
  }

  .btn.primary {
    color: var(--primary-fg);
    background: var(--primary);
    border: none;
  }

  .btn.primary:hover {
    opacity: 0.9;
  }

  .btn.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
