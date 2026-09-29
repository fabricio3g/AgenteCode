<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { ChevronDown, MoreHorizontal, Search, TestTube2 } from 'lucide-svelte';
  import { say } from '$lib/copy';
  import {
    Badge,
    Button,
    Field,
    Input,
    Select,
    Switch,
  } from '$lib/components/ui';
  import { motionSlide } from '$lib/utils/transitions';
  import {
    getAggregatorCatalog,
    probeAggregatorEngines,
    type AggregatorCatalogItem,
  } from '$lib/services/search';

  type SearchProviderItem = {
    id: string;
    label: string;
    needsKey?: boolean;
    needsUrl?: boolean;
    /** Where to get a key; the free-tier providers first. */
    keyUrl?: string;
    needsModel?: boolean;
  };

  /*
   * Only providers used through their official API (or your own SearXNG).
   * Result-page scrapers and resellers of scraped Google results are gone.
   */
  const SEARCH_PROVIDERS: SearchProviderItem[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'aggregator', label: 'Agente Aggregator' },
    { id: 'tavily', label: 'Tavily', needsKey: true, keyUrl: 'https://app.tavily.com' },
    { id: 'exa', label: 'Exa', needsKey: true, keyUrl: 'https://dashboard.exa.ai' },
    { id: 'brave', label: 'Brave Search', needsKey: true, keyUrl: 'https://api-dashboard.search.brave.com' },
    { id: 'searxng', label: 'SearXNG', needsUrl: true },
    { id: 'jina', label: 'Jina AI', needsKey: true, needsUrl: true, keyUrl: 'https://jina.ai/api-dashboard' },
    { id: 'perplexity', label: 'Perplexity', needsKey: true, needsModel: true, keyUrl: 'https://www.perplexity.ai/account/api' },
    { id: 'youcom', label: 'You.com', needsKey: true, keyUrl: 'https://api.you.com' },
  ];

  const ENGINE_GROUPS: Array<{
    id: string;
    label: string;
    includes: (item: AggregatorCatalogItem) => boolean;
  }> = [
    { id: 'recommended', label: 'Recommended', includes: (item) => item.recommended },
    { id: 'general', label: 'General', includes: (item) => !item.recommended && item.category === 'general' },
    { id: 'research', label: 'Research', includes: (item) => item.category === 'research' },
    { id: 'configured', label: 'Self-hosted / API', includes: (item) => item.category === 'self_hosted' || item.category === 'api' },
  ];

  let {
    searchProvider = $bindable(),
    searchMaxResults = $bindable(),
    searchApiKey = $bindable(),
    searchBaseUrl = $bindable(),
    searchModel = $bindable(),
    searchApiUrl = $bindable(),
    aggregatorEngines = $bindable(),
    searchSafeSearch = $bindable(),
    aggregatorProviders = $bindable(),
    onSaveConfiguration,
    savingConfiguration = false,
  }: {
    searchProvider: string;
    searchMaxResults: string;
    searchApiKey: string;
    searchBaseUrl: string;
    searchModel: string;
    searchApiUrl: string;
    aggregatorEngines: string[];
    searchSafeSearch: string;
    aggregatorProviders: Record<string, Record<string, unknown>>;
    onSaveConfiguration: () => Promise<void>;
    savingConfiguration?: boolean;
  } = $props();

  let catalog = $state<AggregatorCatalogItem[]>([]);
  let engineFilter = $state('');
  let catalogError = $state('');
  let probing = $state(false);
  let actionsOpen = $state(false);
  let openConfigurations = $state<Record<string, boolean>>({});
  let probeStatuses = $state<Record<string, { success: boolean; detail: string }>>({});

  const currentSearchProvider = $derived(
    SEARCH_PROVIDERS.find((provider) => provider.id === searchProvider) || SEARCH_PROVIDERS[0]
  );
  const visibleCatalog = $derived(catalog.filter((item) => {
    const needle = engineFilter.trim().toLowerCase();
    return !needle || `${item.label} ${item.id} ${item.category} ${item.stability}`.toLowerCase().includes(needle);
  }));
  const providerNeedsConfiguration = $derived(
    Boolean(
      currentSearchProvider.needsKey
      || currentSearchProvider.needsUrl
      || currentSearchProvider.needsModel
    )
  );

  onMount(async () => {
    try {
      catalog = (await getAggregatorCatalog()) ?? [];
    } catch (error) {
      catalogError = error instanceof Error ? error.message : 'Could not load the engine catalog.';
    }
  });

  function configValue(engineId: string, key: 'api_key' | 'base_url'): string {
    return String(aggregatorProviders?.[engineId]?.[key] || '');
  }

  function updateConfig(engineId: string, key: 'api_key' | 'base_url', value: string) {
    aggregatorProviders = {
      ...aggregatorProviders,
      [engineId]: { ...(aggregatorProviders?.[engineId] || {}), [key]: value },
    };
  }

  function missingRequirements(item: AggregatorCatalogItem): string[] {
    return item.requires.filter((requirement) => !configValue(item.id, requirement).trim());
  }

  function toggleEngine(item: AggregatorCatalogItem) {
    if (aggregatorEngines.includes(item.id)) {
      aggregatorEngines = aggregatorEngines.filter((id) => id !== item.id);
      return;
    }
    if (missingRequirements(item).length) {
      openConfigurations = { ...openConfigurations, [item.id]: true };
      return;
    }
    aggregatorEngines = [...aggregatorEngines, item.id];
  }

  function enableRecommended() {
    aggregatorEngines = catalog
      .filter((item) => item.recommended && missingRequirements(item).length === 0)
      .map((item) => item.id);
    actionsOpen = false;
  }

  function enableAll() {
    aggregatorEngines = catalog
      .filter((item) => missingRequirements(item).length === 0)
      .map((item) => item.id);
    actionsOpen = false;
  }

  function disableAll() {
    aggregatorEngines = [];
    actionsOpen = false;
  }

  function buildProbeOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {
      aggregator_engines: aggregatorEngines,
      safe_search: Number(searchSafeSearch),
    };
    for (const [id, config] of Object.entries(aggregatorProviders || {})) {
      if (config.api_key) options[`${id}_api_key`] = config.api_key;
      if (config.base_url) options[`${id}_base_url`] = config.base_url;
    }
    return options;
  }

  async function probeEnabledEngines() {
    if (!aggregatorEngines.length) return;
    probing = true;
    probeStatuses = {};
    try {
      const result = await probeAggregatorEngines(aggregatorEngines, buildProbeOptions());
      probeStatuses = Object.fromEntries(result.engine_attempts.map((attempt) => [
        attempt.engine,
        {
          success: attempt.success,
          detail: attempt.success
            ? `${say.results(attempt.result_count)} · ${attempt.latency_ms} ms`
            : attempt.missing?.length
              ? `Missing ${attempt.missing.join(' and ').replaceAll('_', ' ')}`
              : attempt.cooldown_until
                ? `Cooling down until ${new Date(attempt.cooldown_until).toLocaleTimeString()}`
                : attempt.error || 'No results',
        },
      ]));
    } catch (error) {
      catalogError = error instanceof Error ? error.message : 'Could not test the selected engines.';
    } finally {
      probing = false;
    }
  }
</script>

<div class="space-y-5">
  <section class="rounded-2xl bg-[var(--muted)]">
    <div class="px-4">
      <Field
        horizontal
        class="py-3"
        label="Search provider"
        description="Use one provider directly, or combine an engine pool."
        htmlFor="search-provider"
      >
        <Select
          id="search-provider"
          bind:value={searchProvider}
          options={SEARCH_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
        />
      </Field>

      <Field
        horizontal
        class="py-3"
        label="Target results"
        description="Standard web searches request 1–20 results. Deep modes use their own larger research budget."
        htmlFor="search-result-target"
      >
        <Input
          id="search-result-target"
          type="number"
          min="1"
          max="20"
          inputmode="numeric"
          bind:value={searchMaxResults}
        />
      </Field>

      <Field
        horizontal
        class="py-3"
        label="Safe search"
        description="Applied when the selected engine supports it."
        htmlFor="safe-search"
      >
        <Select
          id="safe-search"
          bind:value={searchSafeSearch}
          options={[
            { value: '0', label: 'Off' },
            { value: '2', label: 'Moderate' },
            { value: '4', label: 'Strict' },
          ]}
        />
      </Field>
    </div>
  </section>

  {#if providerNeedsConfiguration && searchProvider !== 'aggregator'}
    <section class="rounded-2xl bg-[var(--muted)] p-4">
      <h4 class="text-sm font-semibold text-foreground">{currentSearchProvider.label} configuration</h4>
      <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
        This provider remains inactive until its required fields are saved successfully.
      </p>
      <div class="mt-4 space-y-3">
        {#if currentSearchProvider.needsKey}
          <Field label="API key" htmlFor="search-api-key">
            <Input id="search-api-key" type="password" bind:value={searchApiKey} placeholder={`${currentSearchProvider.label} API key`} />
          </Field>
          {#if currentSearchProvider.keyUrl}
            <a class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" href={currentSearchProvider.keyUrl} target="_blank" rel="noreferrer">{$t('searchSettings.getKey', { values: { name: currentSearchProvider.label } })}</a>
          {/if}
        {/if}
        {#if currentSearchProvider.needsUrl}
          <Field label="Base URL" htmlFor="search-base-url">
            <Input id="search-base-url" bind:value={searchBaseUrl} placeholder="https://…" />
          </Field>
        {/if}
        {#if currentSearchProvider.needsModel}
          <Field label="Model" htmlFor="search-model">
            <Input id="search-model" bind:value={searchModel} placeholder="sonar" />
          </Field>
          <Field label="API URL" htmlFor="search-api-url">
            <Input id="search-api-url" bind:value={searchApiUrl} placeholder="https://api.perplexity.ai" />
          </Field>
        {/if}
      </div>
      <div class="mt-4 flex justify-end">
        <Button loading={savingConfiguration} loadingLabel="Saving…" onclick={onSaveConfiguration}>Save and use</Button>
      </div>
    </section>
  {/if}

  {#if searchProvider === 'aggregator'}
    <section class="overflow-hidden rounded-2xl bg-[var(--muted)]">
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-4">
        <div>
          <div class="flex items-center gap-2">
            <h4 class="text-sm font-semibold text-foreground">Engine pool</h4>
            <Badge>{aggregatorEngines.length} enabled</Badge>
          </div>
          <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
            Only enabled engines with complete configuration receive a query.
          </p>
        </div>
        <div class="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            loading={probing}
            loadingLabel="Testing…"
            onclick={probeEnabledEngines}
            disabled={aggregatorEngines.length === 0}
          >
            <TestTube2 /> Test enabled
          </Button>
          <div class="relative">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Engine pool actions"
              aria-expanded={actionsOpen}
              onclick={() => (actionsOpen = !actionsOpen)}
            >
              <MoreHorizontal />
            </Button>
            {#if actionsOpen}
              <div
                class="absolute right-0 top-10 z-20 w-52 rounded-lg border border-border bg-popover p-1 shadow-lg"
                transition:motionSlide={{ duration: 180 }}
              >
                <button class="w-full rounded-md px-2.5 py-2 text-left text-xs text-foreground hover:bg-muted" type="button" onclick={enableRecommended}>Enable recommended</button>
                <button class="w-full rounded-md px-2.5 py-2 text-left text-xs text-foreground hover:bg-muted" type="button" onclick={enableAll}>Enable all configured</button>
                <button class="w-full rounded-md px-2.5 py-2 text-left text-xs text-foreground hover:bg-muted" type="button" onclick={disableAll}>Disable all</button>
                <button class="w-full rounded-md px-2.5 py-2 text-left text-xs text-foreground hover:bg-muted" type="button" onclick={enableRecommended}>Reset to recommended</button>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <div class="border-b border-[var(--border-subtle)] p-3">
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input class="pl-9" bind:value={engineFilter} placeholder="Filter engines…" aria-label="Filter engines" />
        </div>
      </div>

      {#if aggregatorEngines.length === 0}
        <div class="border-b border-warning-border bg-warning-bg px-4 py-2.5 text-xs text-warning">
          Enable at least one engine. This empty pool will not replace your last saved selection.
        </div>
      {/if}
      {#if catalogError}
        <div class="border-b border-error-border bg-error-bg px-4 py-2.5 text-xs text-error">{catalogError}</div>
      {/if}

      <div class="max-h-[520px] overflow-y-auto">
        {#each ENGINE_GROUPS as group (group.id)}
          {@const items = visibleCatalog.filter(group.includes)}
          {#if items.length}
            <div class="border-b border-[var(--border-subtle)] last:border-b-0">
              <div class="sticky top-0 z-10 bg-card/95 px-4 py-2 backdrop-blur">
                <h5 class="text-[11px] font-semibold text-muted-foreground">{group.label}</h5>
              </div>
              <div class="">
                {#each items as item (item.id)}
                  {@const missing = missingRequirements(item)}
                  {@const selected = aggregatorEngines.includes(item.id)}
                  {@const configurationOpen = Boolean(openConfigurations[item.id])}
                  <div class="px-4">
                    <div class="flex min-h-[62px] items-center gap-3 py-3">
                      <Switch
                        checked={selected}
                        label={`${selected ? 'Disable' : 'Enable'} ${item.label}`}
                        disabled={!selected && missing.length > 0}
                        onchange={() => toggleEngine(item)}
                      />
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="text-sm font-medium text-foreground">{item.label}</span>
                          {#if item.recommended}<Badge tone="success">Recommended</Badge>{/if}
                          {#if item.stability === 'experimental'}<Badge tone="warning">Experimental</Badge>{/if}
                        </div>
                        <div class="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          <span>{item.transport.toUpperCase()}</span>
                          <span aria-hidden="true">·</span>
                          <span>{item.stability}</span>
                          {#if missing.length}
                            <span aria-hidden="true">·</span>
                            <span class="text-warning">Missing {missing.join(' and ').replaceAll('_', ' ')}</span>
                          {:else if item.requires.length}
                            <span aria-hidden="true">·</span>
                            <span class="text-success">Configured</span>
                          {/if}
                        </div>
                        {#if probeStatuses[item.id]}
                          <p class={`mt-1 text-[11px] ${probeStatuses[item.id].success ? 'text-success' : 'text-warning'}`}>
                            {probeStatuses[item.id].detail}
                          </p>
                        {/if}
                      </div>
                      {#if item.requires.length}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={configurationOpen}
                          onclick={() => (openConfigurations = { ...openConfigurations, [item.id]: !configurationOpen })}
                        >
                          Configure
                          <ChevronDown class={`transition-transform duration-[var(--motion-normal)] ${configurationOpen ? 'rotate-180' : ''}`} />
                        </Button>
                      {/if}
                    </div>

                    {#if configurationOpen && item.requires.length}
                      <div class="border-t border-[var(--border-subtle)] py-3" transition:motionSlide={{ duration: 180 }}>
                        <div class="space-y-3 rounded-lg bg-muted/35 p-3">
                          {#if item.requires.includes('base_url')}
                            <Field label="Base URL" htmlFor={`${item.id}-base-url`}>
                              <Input
                                id={`${item.id}-base-url`}
                                value={configValue(item.id, 'base_url')}
                                oninput={(event) => updateConfig(item.id, 'base_url', event.currentTarget.value)}
                                placeholder={item.default_base_url || `${item.label} base URL`}
                              />
                            </Field>
                          {/if}
                          {#if item.requires.includes('api_key')}
                            <Field label="API key" htmlFor={`${item.id}-api-key`}>
                              <Input
                                id={`${item.id}-api-key`}
                                type="password"
                                value={configValue(item.id, 'api_key')}
                                oninput={(event) => updateConfig(item.id, 'api_key', event.currentTarget.value)}
                                placeholder={`${item.label} API key`}
                              />
                            </Field>
                          {/if}
                          <div class="flex items-center justify-between gap-3">
                            <p class="text-[11px] leading-relaxed text-muted-foreground">
                              Saving configuration never enables this engine automatically.
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              loading={savingConfiguration}
                              loadingLabel="Saving…"
                              onclick={onSaveConfiguration}
                            >
                              Save configuration
                            </Button>
                          </div>
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/each}

        {#if catalog.length > 0 && visibleCatalog.length === 0}
          <div class="px-4 py-10 text-center text-sm text-muted-foreground">No engines match “{engineFilter}”.</div>
        {/if}
      </div>
    </section>
  {/if}
</div>
