<svelte:options runes={true} />

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { t } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { ChevronDown, MoreHorizontal, Search, TestTube2 } from 'lucide-svelte';
  import { get } from 'svelte/store';
  import { say } from '$lib/copy';
  import {
    Badge,
    Button,
    Field,
    Input,
    Menu,
    MenuItem,
    Select,
    Switch,
  } from '$lib/components/ui';
  import { motionSlide } from '$lib/utils/transitions';
  import SettingsSection from './SettingsSection.svelte';
  import SettingsRow from './SettingsRow.svelte';
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
    { id: 'auto', label: '' },
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
    labelKey: string;
    includes: (item: AggregatorCatalogItem) => boolean;
  }> = [
    { id: 'recommended', labelKey: 'searchSettings.group.recommended', includes: (item) => item.recommended },
    { id: 'general', labelKey: 'searchSettings.group.general', includes: (item) => !item.recommended && item.category === 'general' },
    { id: 'research', labelKey: 'searchSettings.group.research', includes: (item) => item.category === 'research' },
    { id: 'configured', labelKey: 'searchSettings.group.configured', includes: (item) => item.category === 'self_hosted' || item.category === 'api' },
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
  const tr = (key: string, values?: Record<string, string | number>) => get(t)(key, values ? { values } : undefined);
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
      catalogError = error instanceof Error ? error.message : tr('searchSettings.catalogError');
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
  }

  function enableAll() {
    aggregatorEngines = catalog
      .filter((item) => missingRequirements(item).length === 0)
      .map((item) => item.id);
  }

  function disableAll() {
    aggregatorEngines = [];
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
              ? tr('searchSettings.missing', { what: attempt.missing.join(' and ').replaceAll('_', ' ') })
              : attempt.cooldown_until
                ? tr('searchSettings.cooldown', { time: new Date(attempt.cooldown_until).toLocaleTimeString() })
                : attempt.error || tr('searchSettings.noResults'),
        },
      ]));
    } catch (error) {
      catalogError = error instanceof Error ? error.message : tr('searchSettings.probeError');
    } finally {
      probing = false;
    }
  }
</script>

<div class="space-y-5">
  <SettingsSection title={$t('searchSettings.providerSection')}>
    <SettingsRow
      label={$t('searchSettings.provider')}
      description={$t('searchSettings.providerHint')}
      htmlFor="search-provider"
    >
      <Select
        id="search-provider"
        bind:value={searchProvider}
        options={SEARCH_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.id === 'auto' ? $t('searchSettings.auto') : provider.label }))}
      />
    </SettingsRow>

    <SettingsRow
      label={$t('searchSettings.targetResults')}
      description={$t('searchSettings.targetResultsHint')}
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
    </SettingsRow>

    <SettingsRow
      label={$t('searchSettings.safeSearch')}
      description={$t('searchSettings.safeSearchHint')}
      htmlFor="safe-search"
    >
      <Select
        id="safe-search"
        bind:value={searchSafeSearch}
        options={[
          { value: '0', label: $t('searchSettings.safeOff') },
          { value: '2', label: $t('searchSettings.safeModerate') },
          { value: '4', label: $t('searchSettings.safeStrict') },
        ]}
      />
    </SettingsRow>
  </SettingsSection>

  {#if providerNeedsConfiguration && searchProvider !== 'aggregator'}
    <SettingsSection
      title={$t('searchSettings.configuration', { values: { name: currentSearchProvider.label } })}
      description={$t('searchSettings.configurationHint')}
    >
      {#if currentSearchProvider.needsKey}
        <SettingsRow label={$t('searchSettings.apiKey')} htmlFor="search-api-key" control="lg">
          <Input id="search-api-key" type="password" bind:value={searchApiKey} placeholder={$t('searchSettings.apiKeyFor', { values: { name: currentSearchProvider.label } })} />
        </SettingsRow>
      {/if}
      {#if currentSearchProvider.needsUrl}
        <SettingsRow label={$t('searchSettings.baseUrl')} htmlFor="search-base-url" control="lg">
          <Input id="search-base-url" bind:value={searchBaseUrl} placeholder="https://…" />
        </SettingsRow>
      {/if}
      {#if currentSearchProvider.needsModel}
        <SettingsRow label={$t('searchSettings.model')} htmlFor="search-model" control="lg">
          <Input id="search-model" bind:value={searchModel} placeholder="sonar" />
        </SettingsRow>
        <SettingsRow label={$t('searchSettings.apiUrl')} htmlFor="search-api-url" control="lg">
          <Input id="search-api-url" bind:value={searchApiUrl} placeholder="https://api.perplexity.ai" />
        </SettingsRow>
      {/if}
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        {#if currentSearchProvider.keyUrl}
          <a class="text-[length:var(--text-xs)] text-muted-foreground underline underline-offset-2 hover:text-foreground" href={currentSearchProvider.keyUrl} target="_blank" rel="noreferrer">{$t('searchSettings.getKey', { values: { name: currentSearchProvider.label } })}</a>
        {:else}<span></span>{/if}
        <Button loading={savingConfiguration} loadingLabel={$t('searchSettings.saving')} onclick={onSaveConfiguration}>{$t('searchSettings.saveAndUse')}</Button>
      </div>
    </SettingsSection>
  {/if}

  {#if searchProvider === 'aggregator'}
    <section class="overflow-hidden rounded-[var(--float-radius)] border border-[var(--float-border)] bg-[var(--card)]">
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <div class="flex items-center gap-2">
            <h4 class="text-[length:var(--text-sm)] font-semibold text-foreground">{$t('searchSettings.enginePool')}</h4>
            <Badge>{$t('searchSettings.enabledCount', { values: { n: aggregatorEngines.length } })}</Badge>
          </div>
          <p class="mt-1 text-[length:var(--text-xs)] leading-relaxed text-muted-foreground">
            {$t('searchSettings.enginePoolHint')}
          </p>
        </div>
        <div class="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            loading={probing}
            loadingLabel={$t('searchSettings.testing')}
            onclick={probeEnabledEngines}
            disabled={aggregatorEngines.length === 0}
          >
            <TestTube2 /> {$t('searchSettings.testEnabled')}
          </Button>
          <Menu bind:open={actionsOpen} placement="bottom-end">
            {#snippet trigger(props)}
              <IconButton label={$t('searchSettings.poolActions')} {...props} variant="ghost" size="sm" >
                <MoreHorizontal />
              </IconButton>
            {/snippet}
            <MenuItem label={$t('searchSettings.enableRecommended')} onselect={enableRecommended} />
            <MenuItem label={$t('searchSettings.enableAll')} onselect={enableAll} />
            <MenuItem label={$t('searchSettings.disableAll')} onselect={disableAll} />
            <MenuItem label={$t('searchSettings.resetRecommended')} onselect={enableRecommended} />
          </Menu>
        </div>
      </div>

      <div class="border-b border-[var(--border-subtle)] p-3">
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input class="pl-9" bind:value={engineFilter} placeholder={$t('searchSettings.filter')} aria-label={$t('searchSettings.filterLabel')} />
        </div>
      </div>

      {#if aggregatorEngines.length === 0}
        <div class="border-b border-warning-border bg-warning-bg px-4 py-2.5 text-[length:var(--text-xs)] text-warning">
          {$t('searchSettings.emptyPool')}
        </div>
      {/if}
      {#if catalogError}
        <div class="border-b border-error-border bg-error-bg px-4 py-2.5 text-[length:var(--text-xs)] text-error">{catalogError}</div>
      {/if}

      <div class="max-h-[520px] overflow-y-auto">
        {#each ENGINE_GROUPS as group (group.id)}
          {@const items = visibleCatalog.filter(group.includes)}
          {#if items.length}
            <div class="border-b border-[var(--border-subtle)] last:border-b-0">
              <div class="sticky top-0 z-10 bg-card/95 px-4 py-2 backdrop-blur">
                <h5 class="text-[length:var(--text-xs)] font-semibold text-muted-foreground">{$t(group.labelKey)}</h5>
              </div>
              <div>
                {#each items as item (item.id)}
                  {@const missing = missingRequirements(item)}
                  {@const selected = aggregatorEngines.includes(item.id)}
                  {@const configurationOpen = Boolean(openConfigurations[item.id])}
                  <div class="px-4">
                    <div class="flex min-h-[62px] items-center gap-3 py-3">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="text-[length:var(--text-sm)] font-medium text-foreground">{item.label}</span>
                          {#if item.stability === 'experimental'}<Badge tone="warning">{$t('searchSettings.experimental')}</Badge>{/if}
                        </div>
                        <div class="mt-0.5 flex flex-wrap items-center gap-1 text-[length:var(--text-xs)] text-muted-foreground">
                          <span>{item.transport.toUpperCase()}</span>
                          <span aria-hidden="true">·</span>
                          <span>{item.stability}</span>
                          {#if missing.length}
                            <span aria-hidden="true">·</span>
                            <span class="text-warning">{$t('searchSettings.missing', { values: { what: missing.join(' and ').replaceAll('_', ' ') } })}</span>
                          {:else if item.requires.length}
                            <span aria-hidden="true">·</span>
                            <span class="text-success">{$t('searchSettings.configured')}</span>
                          {/if}
                        </div>
                        {#if probeStatuses[item.id]}
                          <p class={`mt-1 text-[length:var(--text-xs)] ${probeStatuses[item.id].success ? 'text-success' : 'text-warning'}`}>
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
                          {$t('searchSettings.configure')}
                          <ChevronDown class={`transition-transform duration-[var(--motion-normal)] ${configurationOpen ? 'rotate-180' : ''}`} />
                        </Button>
                      {/if}
                      <Switch
                        checked={selected}
                        label={$t(selected ? 'searchSettings.disable' : 'searchSettings.enable', { values: { name: item.label } })}
                        disabled={!selected && missing.length > 0}
                        onchange={() => toggleEngine(item)}
                      />
                    </div>

                    {#if configurationOpen && item.requires.length}
                      <div class="border-t border-[var(--border-subtle)] py-3" transition:motionSlide={{ duration: 180 }}>
                        <div class="space-y-3 rounded-[var(--float-row-radius)] bg-muted/35 p-3">
                          {#if item.requires.includes('base_url')}
                            <Field label={$t('searchSettings.baseUrl')} htmlFor={`${item.id}-base-url`}>
                              <Input
                                id={`${item.id}-base-url`}
                                value={configValue(item.id, 'base_url')}
                                oninput={(event) => updateConfig(item.id, 'base_url', event.currentTarget.value)}
                                placeholder={item.default_base_url || $t('searchSettings.baseUrlFor', { values: { name: item.label } })}
                              />
                            </Field>
                          {/if}
                          {#if item.requires.includes('api_key')}
                            <Field label={$t('searchSettings.apiKey')} htmlFor={`${item.id}-api-key`}>
                              <Input
                                id={`${item.id}-api-key`}
                                type="password"
                                value={configValue(item.id, 'api_key')}
                                oninput={(event) => updateConfig(item.id, 'api_key', event.currentTarget.value)}
                                placeholder={$t('searchSettings.apiKeyFor', { values: { name: item.label } })}
                              />
                            </Field>
                          {/if}
                          <div class="flex items-center justify-between gap-3">
                            <p class="text-[length:var(--text-xs)] leading-relaxed text-muted-foreground">
                              {$t('searchSettings.saveNote')}
                            </p>
                            <Button
                              variant="outline"
                              size="sm"
                              loading={savingConfiguration}
                              loadingLabel={$t('searchSettings.saving')}
                              onclick={onSaveConfiguration}
                            >
                              {$t('searchSettings.saveConfiguration')}
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
          <div class="px-4 py-10 text-center text-[length:var(--text-sm)] text-muted-foreground">{$t('searchSettings.noMatch', { values: { query: engineFilter } })}</div>
        {/if}
      </div>
    </section>
  {/if}
</div>
