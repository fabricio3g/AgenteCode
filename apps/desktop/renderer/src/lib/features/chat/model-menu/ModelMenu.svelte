<svelte:options runes={true} />

<!--
  The composer's model control: one pill that says which model answers and
  how hard it thinks, and one short menu to change either.

  The menu leads with the models used lately — cloud and this computer mixed,
  because most choices are a return — then three doors: Effort ›, This
  computer › and Cloud ›. There is no Cloud / On-device switch: the model you
  pick decides where a chat runs. The on-device model is one for the whole app
  (one llama.cpp server), so its door says so and shows how many chats use it.
  "All models…" opens the full searchable list. A card beside the menu tells
  what a model costs and accepts before you pick it.

  Without props it drives the app's model and thinking level; Code passes its
  conversation and that conversation's thinking capabilities.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { Check, ChevronDown, Cpu, Cloud, Brain, LoaderCircle, ArrowDownToLine, SlidersHorizontal, Settings2, Search } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import SubMenu, { submenuGroup } from '$lib/components/ui/SubMenu.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { recentModels, recentKey, type RecentModel } from '$lib/stores/recent-models.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { reasoningRouteIdentity } from '$lib/services/reasoning-route';
  import { normalizeThinkingMode } from '$lib/stores/app-store-local-model';
  import { configuredProviders, defaultBaseUrl } from '$lib/utils/providers';
  import { formatBudget } from '../composer/reasoning-effort';
  import type { ChatSession, ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';
  import ModelSwitcher from '../ModelSwitcher.svelte';
  import ModelCard from './ModelCard.svelte';
  import { localFit, shortModelName, type CardTarget } from './model-menu';

  type LocalModel = (typeof modelsStore.availableModels)[number];

  let {
    compact = false,
    chat = null,
    capabilities: givenCapabilities,
    level: givenLevel,
    onlevel,
    name,
    pinned
  }: {
    /** Text for the pill when it follows the app's model by another name ("Same as chat"). */
    name?: string;
    /** A model fixed elsewhere (a bot's pin): the pill shows it and opens no menu. */
    pinned?: { provider: string; model: string };
    compact?: boolean;
    chat?: ChatSession | null;
    capabilities?: ReasoningCapabilities;
    level?: ReasoningLevel | null;
    onlevel?: (level: ReasoningLevel | null) => void;
  } = $props();

  let open = $state(false);
  let allOpen = $state(false);
  let allSource = $state<'all' | 'cloud' | 'local'>('all');
  let allProvider = $state<string | null>(null);
  let confirmId = $state<string | null>(null);
  let cardTarget = $state<CardTarget | null>(null);
  let cardAnchor = $state<HTMLElement | null>(null);
  const group = submenuGroup();

  // ── What this pill is set to ─────────────────────────────────────────
  const ownConfig = $derived(chat ? appStore.configForChat(chat) : appStore.config);
  const backend = $derived(ownConfig.llm?.backend_mode ?? (isElectron() ? 'local' : 'api'));
  const provider = $derived(ownConfig.llm?.provider ?? '');
  const cloudModel = $derived(ownConfig.llm?.providers?.[provider]?.model ?? '');
  const loadedPath = $derived(appStore.localModelActive?.path?.toLowerCase() || '');
  const loadedName = $derived(shortModelName(appStore.localModelActive?.name));
  const loading = $derived(appStore.localModelLoading);
  const providers = $derived.by(() => {
    void appStore.config?.llm?.providers;
    return configuredProviders(appStore.config, { includeActiveAlways: true });
  });
  const providerLabel = (id: string) => providers.find((item) => item.id === id)?.label ?? id;

  /**
   * Nothing to answer with yet: no provider key, or no model on this computer.
   * The pill itself says so (an accent dot and the next step) instead of a
   * notice line above the composer.
   */
  const needsSetup = $derived(
    backend === 'local'
      ? !loading && !appStore.localModelActive
      : !provider || !cloudModel || !(appStore.config.llm?.providers?.[provider]?.has_api_key || appStore.config.llm?.providers?.[provider]?.api_key)
  );
  const label = $derived(
    pinned ? shortModelName(pinned.model) : name ? name :
    backend === 'local'
      ? loading ? shortModelName(appStore.localModelLoadTarget?.name) || loadedName : loadedName || $t('modelPicker.selectModel')
      : needsSetup && !(appStore.config.llm?.providers?.[provider]?.has_api_key) ? $t('modelPicker.configureProvider') : shortModelName(cloudModel) || $t('modelPicker.selectModel')
  );

  // ── Thinking: the same profile and words as ReasoningLevelSelector ────
  const controlled = $derived(!!givenCapabilities);
  const appCapabilities = $derived(appStore.reasoningCapabilities);
  const routeMatches = $derived(!appCapabilities.route || appCapabilities.route === reasoningRouteIdentity(appStore.config));
  const capabilities = $derived(givenCapabilities ?? (routeMatches ? appCapabilities : { supported: false, levels: [], source: 'unknown' } as ReasoningCapabilities));
  const effortVisible = $derived(capabilities.source !== 'unknown' && capabilities.supported && capabilities.levels.length > 0);
  const levels = $derived<Array<ReasoningLevel | null>>([null, ...capabilities.levels]);
  const chosenLevel = $derived(controlled ? (givenLevel ?? null) : appStore.reasoningLevel);
  const currentLevel = $derived(levels.includes(chosenLevel) ? chosenLevel : null);
  const modelDefault = $derived<ReasoningLevel | 'auto'>(!controlled && backend === 'local'
    ? normalizeThinkingMode(appStore.config.llm?.local?.thinking_mode, appStore.config.llm?.local?.disable_thinking)
    : capabilities.default ?? 'auto');

  function levelLabel(value: ReasoningLevel | null): string {
    if (value !== null) return $t(`composer.thinking.level.${value}`);
    return modelDefault === 'auto'
      ? $t('composer.thinking.level.auto')
      : $t('composer.thinking.modelDefault', { values: { level: $t(`composer.thinking.level.${modelDefault}`) } });
  }

  function levelHint(value: ReasoningLevel | null): string {
    const hint = $t(`composer.thinking.hint.${value ?? 'auto'}`, { default: '' });
    const budget = value ? capabilities.budgets?.[value] : undefined;
    return typeof budget === 'number' ? `${hint} · ${$t('composer.thinking.budget', { values: { tokens: formatBudget(budget) } })}` : hint;
  }

  function setLevel(value: ReasoningLevel | null) {
    if (controlled) onlevel?.(value);
    else appStore.setReasoningLevel(value);
    open = false;
  }

  // ── This computer ────────────────────────────────────────────────────
  const localModels = $derived<LocalModel[]>(modelsStore.availableModels ?? []);
  const slots = $derived(Number(modelsStore.status?.total_slots) || 0);
  const serverContext = $derived(Number(modelsStore.status?.n_ctx) || 0);
  const perChat = $derived(slots > 0 && serverContext > 0 ? Math.floor(serverContext / slots) : null);
  /** Chats replying through the on-device model right now. */
  const localBusy = $derived(appStore.chats.filter((item) => appStore.isChatGenerating(item.id) && appStore.configForChat(item).llm?.backend_mode === 'local').length);

  function isLoaded(model: { path?: string; name?: string }) {
    if (!appStore.localModelActive) return false;
    const path = String(model.path || '').toLowerCase();
    return (!!loadedPath && loadedPath === path) || shortModelName(model.name).toLowerCase() === loadedName.toLowerCase();
  }

  function localCard(model: LocalModel): CardTarget {
    return {
      kind: 'local',
      name: shortModelName(model.name),
      sizeGb: model.size_gb,
      quantization: model.quantization_name,
      context: model.context_length,
      fit: localFit(model.size_gb, hardwareStore.info),
      tools: model.chat_template_uses_tools === true,
      perChat: isLoaded(model) ? perChat : null
    };
  }

  // ── Recents: the current model first, then the ones used lately ─────
  const currentEntry = $derived<RecentModel | null>(
    backend === 'local'
      ? appStore.localModelActive?.path ? { kind: 'local', id: appStore.localModelActive.path, name: loadedName, path: appStore.localModelActive.path } : null
      : provider && cloudModel ? { kind: 'cloud', provider, model: cloudModel, name: shortModelName(cloudModel) } : null
  );
  const recentRows = $derived.by(() => {
    const rows: RecentModel[] = currentEntry ? [currentEntry] : [];
    const seen = new Set(rows.map(recentKey));
    for (const item of recentModels.list) {
      if (seen.has(recentKey(item))) continue;
      if (item.kind === 'local' && !localModels.some((model) => model.path === item.path)) continue;
      seen.add(recentKey(item));
      rows.push(item);
    }
    return rows.slice(0, 4);
  });
  const currentKey = $derived(currentEntry ? recentKey(currentEntry) : '');

  // Whatever runs now joins the recents, however it was chosen (this menu,
  // the full list, Settings), so the model before it is one click back.
  $effect(() => {
    const entry = currentEntry;
    if (entry) untrack(() => recentModels.remember(entry));
  });

  // ── Picking ──────────────────────────────────────────────────────────
  function focusChat() {
    if (chat && appStore.currentChatId !== chat.id) appStore.selectChat(chat.id);
  }

  async function pickCloud(providerId: string, modelId: string, name: string) {
    open = false;
    focusChat();
    try {
      if (appStore.backendMode !== 'api') await appStore.setBackendMode('api');
      if (appStore.activeProviderName !== providerId || appStore.activeProvider?.model !== modelId) {
        const saved = appStore.config.llm?.providers?.[providerId];
        await appStore.updateProvider({ provider: providerId, base_url: saved?.base_url || defaultBaseUrl(providerId), model: modelId });
      }
      recentModels.remember({ kind: 'cloud', provider: providerId, model: modelId, name });
    } catch {
      toastStore.error(get(t)('modelPicker.switchFailed'));
    }
  }

  /**
   * The loaded model is picked at once. Another one replaces it for every
   * chat, so the first click asks (in the row itself) and the second loads.
   */
  async function pickLocal(model: { id: string; name: string; path?: string }) {
    if (!model.path || loading) return;
    focusChat();
    if (isLoaded(model)) {
      open = false;
      if (appStore.backendMode !== 'local') await appStore.setBackendMode('local');
      recentModels.remember({ kind: 'local', id: model.id, name: model.name, path: model.path });
      return;
    }
    if (appStore.localModelActive && confirmId !== model.path) {
      confirmId = model.path;
      return;
    }
    confirmId = null;
    open = false;
    recentModels.remember({ kind: 'local', id: model.id, name: model.name, path: model.path });
    await appStore.loadLocalModelQuietly({ id: model.id, name: model.name, path: model.path });
  }

  function pickRecent(entry: RecentModel) {
    if (entry.kind === 'cloud') void pickCloud(entry.provider, entry.model, entry.name);
    else void pickLocal({ id: entry.id, name: entry.name, path: entry.path });
  }

  function showAll(source: 'all' | 'cloud' | 'local', providerId: string | null = null) {
    open = false;
    allSource = source;
    allProvider = providerId;
    allOpen = true;
  }

  function settings(section: string) {
    open = false;
    appStore.openSettings(section);
  }

  // ── The card follows the pointer and the arrow keys ──────────────────
  function cardFor(target: () => CardTarget | null) {
    const show = (event: Event) => { cardTarget = target(); cardAnchor = event.currentTarget as HTMLElement; };
    const hide = (event: Event) => { if (cardAnchor === event.currentTarget) { cardTarget = null; cardAnchor = null; } };
    return { onpointerenter: show, onfocus: show, onpointerleave: hide, onblur: hide };
  }

  function recentCard(entry: RecentModel): CardTarget | null {
    if (entry.kind === 'cloud') return { kind: 'cloud', provider: entry.provider, providerLabel: providerLabel(entry.provider), model: entry.model, name: entry.name };
    const model = localModels.find((item) => item.path === entry.path);
    return model ? localCard(model) : null;
  }

  /** A plain row under the pointer closes any open side panel. */
  function closeSideOnPlainRow(event: PointerEvent) {
    const row = (event.target as HTMLElement).closest('[role="menuitem"]');
    if (row && !row.hasAttribute('aria-haspopup')) group.active = null;
  }

  $effect(() => {
    if (open) return;
    group.active = null;
    confirmId = null;
    cardTarget = null;
    cardAnchor = null;
  });

  $effect(() => {
    if (!open) return;
    if (!hardwareStore.info) void hardwareStore.refresh();
    void modelsStore.refreshStatus();
  });
</script>

{#if pinned}
  <Button variant="plain" type="button" class={['model-pill', compact && 'is-compact'].filter(Boolean).join(' ')} disabled title={$t('bots.model')} aria-label={$t('modelPicker.triggerLabel', { values: { model: label } })}>
    <ProviderIcon provider={pinned.provider} size={15} />
    <span class="pill-label">{label}</span>
  </Button>
{:else}
<Menu bind:open placement="top-start" minWidth="16rem" label={$t('modelPicker.title')}>
  {#snippet trigger(props)}
    <Button
      variant="plain"
      {...props}
      type="button"
      class={['model-pill titlebar-no-drag', open && 'is-open', compact && 'is-compact', needsSetup && 'is-setup'].filter(Boolean).join(' ')}
      aria-label={$t('modelPicker.triggerLabel', { values: { model: label } })}
        title={label}
    >
      {#if backend === 'local' && loading}
        <TileMeter mode="busy" />
      {:else if needsSetup}
        <span class="setup-dot" aria-hidden="true"></span>
      {:else if backend === 'local'}
        <Cpu class="pill-icon" />
      {:else}
        <ProviderIcon provider={provider} size={15} />
      {/if}
      <span class="pill-label">{label}</span>
      {#if backend === 'local' && loading}
        <span class="pill-level">· {$t('modelPicker.loadingPct', { values: { pct: Math.round(appStore.localModelLoadProgress || 0) } })}</span>
      {:else if effortVisible && currentLevel !== null}
        <span class="pill-level">· {levelLabel(currentLevel)}</span>
      {/if}
      <ChevronDown class="pill-chevron" />
    </Button>
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="model-menu" onpointerover={closeSideOnPlainRow}>
    {#if recentRows.length}
      <p class="ui-menu-label">{$t('modelPicker.recent')}</p>
      {#each recentRows as entry (recentKey(entry))}
        {@const current = recentKey(entry) === currentKey}
        <MenuItem class="model-row" keepOpen={entry.kind === 'local' && !current} {...cardFor(() => recentCard(entry))} onselect={() => pickRecent(entry)}>
          {#if entry.kind === 'cloud'}<ProviderIcon provider={entry.provider} size={14} />{:else}<Cpu class="size-3.5 text-muted-foreground" />{/if}
          <span class="ui-menu-item-text"><span class="truncate">{entry.name}</span></span>
          {#if entry.kind === 'local' && confirmId === entry.path}<span class="row-note">{$t('modelPicker.switch')}?</span>{/if}
          {#if entry.kind === 'local' && isLoaded(entry)}<span class="live-dot" aria-hidden="true"></span>{/if}
          {#if current}<Check class="ui-menu-check size-3.5" />{/if}
        </MenuItem>
      {/each}
      <div class="ui-menu-separator" role="separator"></div>
    {/if}

    {#if effortVisible}
      <SubMenu {group} key="effort" label={$t('composer.thinking.title')} value={levelLabel(currentLevel)} icon={Brain} minWidth="15rem">
        {#each levels as value (value ?? 'auto')}
          <MenuItem label={levelLabel(value)} description={levelHint(value)} active={value === currentLevel} onselect={() => setLevel(value)} />
        {/each}
      </SubMenu>
    {/if}

    {#if isElectron()}
      <SubMenu {group} key="local" label={$t('modelPicker.onDevice')} value={loadedName || $t('modelPicker.noneLoaded')} icon={Cpu} minWidth="17rem">
        <p class="ui-menu-label side-head"><span>{$t('modelPicker.forAllChats')}</span>{#if localBusy}<span>{$t('modelPicker.chatsUsing', { values: { n: localBusy } })}</span>{/if}</p>
        {#each localModels as model (model.path)}
          {@const loaded = isLoaded(model)}
          {@const fit = localFit(model.size_gb, hardwareStore.info)}
          {@const target = loading && appStore.localModelLoadTarget?.path === model.path}
          <MenuItem class={fit === 'wont' && !loaded ? 'model-row is-off' : 'model-row'} keepOpen {...cardFor(() => localCard(model))} onselect={() => void pickLocal(model)}>
            <span class="ui-menu-item-text">
              <span class="truncate">{shortModelName(model.name)}</span>
              {#if confirmId === model.path}
                <span class="ui-menu-item-hint">{localBusy ? $t('modelPicker.switchBusy', { values: { n: localBusy } }) : $t('modelPicker.switchConfirm', { values: { current: loadedName, next: shortModelName(model.name) } })}</span>
              {/if}
            </span>
            {#if target}<LoaderCircle class="size-3.5 animate-spin text-muted-foreground" />
            {:else if loaded}<span class="row-meta"><span class="live-dot" aria-hidden="true"></span>{$t('modelPicker.loaded')}</span>
            {:else if fit === 'wont'}<span class="row-meta">{$t('modelPicker.wontFit')}</span>
            {:else if model.size_gb}<span class="row-meta">{model.size_gb.toFixed(1)} GB{#if fit === 'tight'} · {$t('modelPicker.tight')}{/if}</span>{/if}
          </MenuItem>
        {/each}
        {#if localModels.length}<div class="ui-menu-separator" role="separator"></div>{/if}
        <MenuItem icon={ArrowDownToLine} label={$t('modelPicker.downloadModels')} onselect={() => settings('explore')} />
        <MenuItem icon={SlidersHorizontal} label={$t('modelPicker.serverSettings')} onselect={() => settings('local')} />
      </SubMenu>
    {/if}

    <SubMenu {group} key="cloud" label={$t('modelPicker.cloud')} value={backend === 'api' ? providerLabel(provider) : ''} icon={Cloud} minWidth="15rem">
      {#each providers as item (item.id)}
        <MenuItem class="model-row"
          {...cardFor(() => item.model ? { kind: 'cloud', provider: item.id, providerLabel: item.label, model: item.model, name: shortModelName(item.model) } : null)}
          onselect={() => showAll('cloud', item.id)}>
          <ProviderIcon provider={item.id} size={14} />
          <span class="ui-menu-item-text"><span class="truncate">{item.label}</span></span>
          {#if item.model}<span class="row-meta">{shortModelName(item.model)}</span>{/if}
        </MenuItem>
      {/each}
      {#if providers.length}<div class="ui-menu-separator" role="separator"></div>{/if}
      <MenuItem icon={Settings2} label={$t('modelPicker.manageProviders')} onselect={() => settings('providers')} />
    </SubMenu>

    <div class="ui-menu-separator" role="separator"></div>
    <MenuItem icon={Search} label={$t('modelPicker.allModels')} onselect={() => showAll('all')} />
  </div>
</Menu>

<ModelCard target={open ? cardTarget : null} anchor={cardAnchor} />
<ModelSwitcher bind:open={allOpen} {chat} source={allSource} provider={allProvider} />
{/if}

<style>
  /* Borderless, like the add button beside it: a soft fill only on hover. */
  :global(.model-pill) {
    display: inline-flex;
    height: 2rem;
    max-width: 20rem;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.625rem;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  :global(.model-pill:hover),
  :global(.model-pill.is-open) {
    background: var(--muted);
    color: var(--foreground);
  }
  :global(.model-pill.is-compact) {
    max-width: 100%;
    padding-inline: 0.5rem;
  }
  :global(.model-pill .pill-icon) { width: 0.875rem; height: 0.875rem; flex-shrink: 0; color: var(--muted-foreground); }
  :global(.model-pill .pill-chevron) { width: 0.875rem; height: 0.875rem; flex-shrink: 0; color: var(--muted-foreground); }
  .pill-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: inherit;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  :global(.model-pill.is-setup) { color: var(--foreground); }
  .setup-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    background: var(--brand-accent);
  }
  .pill-level {
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
  :global(.model-pill:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }

  .model-menu { display: flex; flex-direction: column; }
  :global(.model-row.is-off) { color: var(--muted-foreground); }
  .row-meta, .row-note {
    margin-left: auto;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.3125rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .live-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    background: var(--success);
  }
  :global(.ui-menu-label.side-head) {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }
</style>
