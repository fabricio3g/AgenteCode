<svelte:options runes={true} />

<script lang="ts">
  const SEARCH_PROVIDERS = [
    { id: 'auto', label: 'Auto', needsKey: false },
    { id: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
    { id: 'searxng', label: 'SearXNG', needsKey: false, needsUrl: true },
    { id: 'brave', label: 'Brave Search', needsKey: true },
    { id: 'google_cse', label: 'Google CSE', needsKey: true, needsEngineId: true },
    { id: 'tavily', label: 'Tavily', needsKey: true },
    { id: 'exa', label: 'Exa', needsKey: true },
    { id: 'serpapi', label: 'SerpAPI', needsKey: true },
    { id: 'serper', label: 'Serper (Google)', needsKey: true },
    { id: 'perplexity', label: 'Perplexity', needsKey: true, needsModel: true },
    { id: 'jina', label: 'Jina AI', needsKey: true },
    { id: 'bing', label: 'Bing Search', needsKey: true, needsUrl: true },
    { id: 'youcom', label: 'You.com', needsKey: true },
  ];

  let {
    searchProvider = $bindable(),
    searchMaxResults = $bindable(),
    searchApiKey = $bindable(),
    searchEngineId = $bindable(),
    searchBaseUrl = $bindable(),
    searchModel = $bindable(),
  }: {
    searchProvider: string;
    searchMaxResults: string;
    searchApiKey: string;
    searchEngineId: string;
    searchBaseUrl: string;
    searchModel: string;
  } = $props();

  const currentSearchProvider = $derived(SEARCH_PROVIDERS.find(p => p.id === searchProvider) || SEARCH_PROVIDERS[0]);
  const searchProviderMeta = $derived({
    needsApiKey: currentSearchProvider.needsKey || false,
    needsEngineId: (currentSearchProvider as { needsEngineId?: boolean }).needsEngineId || false,
    needsBaseUrl: (currentSearchProvider as { needsUrl?: boolean }).needsUrl || false,
    needsModel: (currentSearchProvider as { needsModel?: boolean }).needsModel || false,
    keyPlaceholder: currentSearchProvider.id === 'google_cse'
      ? 'Google API key'
      : currentSearchProvider.id === 'brave'
        ? 'Brave Search API key'
        : currentSearchProvider.id === 'tavily'
          ? 'Tavily API key'
          : currentSearchProvider.id === 'exa'
            ? 'Exa API key'
            : currentSearchProvider.id === 'serpapi'
              ? 'SerpAPI key'
              : currentSearchProvider.id === 'serper'
                ? 'Serper API key'
                : currentSearchProvider.id === 'perplexity'
                  ? 'Perplexity API key'
                  : currentSearchProvider.id === 'jina'
                    ? 'Jina API key'
                    : currentSearchProvider.id === 'bing'
                      ? 'Bing Subscription Key'
                      : currentSearchProvider.id === 'youcom'
                        ? 'You.com API key'
                        : 'API key'
  });
</script>

<div class="space-y-6">
  <label class="block space-y-2 text-sm">
    <span class="font-medium text-[var(--text-secondary)]">Search provider</span>
    <select
      class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
      bind:value={searchProvider}
    >
      {#each SEARCH_PROVIDERS as provider}
        <option value={provider.id}>{provider.label}</option>
      {/each}
    </select>
  </label>

  <label class="block space-y-2 text-sm">
    <span class="font-medium text-[var(--text-secondary)]">Max search results</span>
    <input
      class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
      bind:value={searchMaxResults}
      inputmode="numeric"
    />
    <p class="text-xs text-[var(--text-tertiary)]">Used by Search, Deep, and Max modes.</p>
  </label>

  {#if currentSearchProvider.needsKey}
    <label class="block space-y-2 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">{searchProviderMeta.keyPlaceholder}</span>
      <input
        class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={searchApiKey}
        type="password"
        placeholder={searchProviderMeta.keyPlaceholder}
      />
    </label>
  {/if}

  {#if searchProviderMeta.needsEngineId}
    <label class="block space-y-2 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Google Custom Search Engine ID</span>
      <input
        class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={searchEngineId}
        placeholder="CX ID from Programmable Search Engine"
      />
    </label>
  {/if}

  {#if searchProviderMeta.needsBaseUrl}
    <label class="block space-y-2 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">
        {searchProvider === 'searxng' ? 'SearXNG Instance URL' : searchProvider === 'bing' ? 'Bing API Endpoint' : 'Base URL'}
      </span>
      <input
        class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={searchBaseUrl}
        placeholder={searchProvider === 'searxng' ? 'https://searx.be' : 'https://api.bing.microsoft.com/v7.0/search'}
      />
    </label>
  {/if}

  {#if searchProviderMeta.needsModel}
    <label class="block space-y-2 text-sm">
      <span class="font-medium text-[var(--text-secondary)]">Perplexity Model</span>
      <select
        class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-4 py-2.5 text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
        bind:value={searchModel}
      >
        <option value="sonar">Sonar</option>
        <option value="sonar-pro">Sonar Pro</option>
        <option value="sonar-reasoning">Sonar Reasoning</option>
        <option value="sonar-reasoning-pro">Sonar Reasoning Pro</option>
      </select>
    </label>
  {/if}
</div>
