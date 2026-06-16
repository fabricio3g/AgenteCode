<svelte:options runes={true} />

<script lang="ts">
  const SEARCH_PROVIDERS = [
    { id: 'aggregator', label: 'Chatea Aggregator', needsKey: false },
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

<div class="space-y-4">
  <section class="rounded-lg bg-[var(--surface)] p-4 text-[var(--text-secondary)]">
    <h4 class="mb-4 text-base font-medium text-[var(--text)]">Search</h4>

    <div class="flex flex-col gap-3 border-b border-[var(--border)] pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-[var(--text)]">Search provider</h5>
        <p class="text-xs leading-normal text-[var(--text-tertiary)]">Choose the service used for web results.</p>
      </div>
      <select
        class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)] sm:w-72"
        bind:value={searchProvider}
      >
        {#each SEARCH_PROVIDERS as provider}
          <option value={provider.id}>{provider.label}</option>
        {/each}
      </select>
    </div>

    {#if searchProvider === 'aggregator'}
      <div class="mt-4 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-relaxed text-[var(--text-secondary)]">
        Uses Chatea's local web search aggregator by default. It combines free engines such as DuckDuckGo and Wikipedia, then deep search reads pages locally with Mozilla Readability.
      </div>
    {/if}

    <div class="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <h5 class="text-sm font-medium text-[var(--text)]">Max search results</h5>
        <p class="text-xs leading-normal text-[var(--text-tertiary)]">Used by Search, Deep, and Max modes.</p>
      </div>
      <input
        class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)] sm:w-72"
        bind:value={searchMaxResults}
        inputmode="numeric"
      />
    </div>
  </section>

  {#if currentSearchProvider.needsKey || searchProviderMeta.needsEngineId || searchProviderMeta.needsBaseUrl || searchProviderMeta.needsModel}
    <section class="rounded-lg bg-[var(--surface)] p-4 text-[var(--text-secondary)]">
      <h4 class="mb-4 text-base font-medium text-[var(--text)]">Provider details</h4>

      <div class="space-y-4">
        {#if currentSearchProvider.needsKey}
          <label class="block space-y-2 text-sm">
            <span class="font-medium text-[var(--text)]">{searchProviderMeta.keyPlaceholder}</span>
            <input
              class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]"
              bind:value={searchApiKey}
              type="password"
              placeholder={searchProviderMeta.keyPlaceholder}
            />
          </label>
        {/if}

        {#if searchProviderMeta.needsEngineId}
          <label class="block space-y-2 text-sm">
            <span class="font-medium text-[var(--text)]">Google Custom Search Engine ID</span>
            <input
              class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]"
              bind:value={searchEngineId}
              placeholder="CX ID from Programmable Search Engine"
            />
          </label>
        {/if}

        {#if searchProviderMeta.needsBaseUrl}
          <label class="block space-y-2 text-sm">
            <span class="font-medium text-[var(--text)]">
              {searchProvider === 'searxng' ? 'SearXNG Instance URL' : searchProvider === 'bing' ? 'Bing API Endpoint' : 'Base URL'}
            </span>
            <input
              class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)]"
              bind:value={searchBaseUrl}
              placeholder={searchProvider === 'searxng' ? 'https://searx.be' : 'https://api.bing.microsoft.com/v7.0/search'}
            />
          </label>
        {/if}

        {#if searchProviderMeta.needsModel}
          <label class="block space-y-2 text-sm">
            <span class="font-medium text-[var(--text)]">Perplexity Model</span>
            <select
              class="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-hover)]"
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
    </section>
  {/if}
</div>
