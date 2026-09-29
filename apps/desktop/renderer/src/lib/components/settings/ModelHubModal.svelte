<svelte:options runes={true} />

<!--
  Settings & Models shell — a thin chrome over per-section components.
  The sections own their state (ModelWorkspace, VoiceSection,
  ProvidersSection, UnifiedSettingsPanel, LocalRuntimePanel); this file
  owns only the modal frame, navigation, and top-bar actions.
-->

<script module lang="ts">
  let rememberedModelTab: ModelHubTab = 'discover';
</script>

<script lang="ts">
  import ArtifactTypesPanel from './ArtifactTypesPanel.svelte';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { onMount, untrack } from 'svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import {
    Plus, X,
    Search, Cpu, Volume2, Settings, Shapes, Accessibility
  } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { getInstalledRuntimes } from '$lib/services/files';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { CLOUD_PROVIDERS, isProviderConfigured } from '$lib/utils/providers';
  import { DEFAULT_PROVIDER_ID } from '$shared/providers';
  import { t } from 'svelte-i18n';
  import { Button, Dialog, Input } from '$lib/components/ui';
  import SettingsPage from './SettingsPage.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import { resolveModelHubSection } from '$lib/utils/model-hub-routing';
  import UnifiedSettingsPanel from './UnifiedSettingsPanel.svelte';
  import AccessibilitySettings from './AccessibilitySettings.svelte';
  import ModelWorkspace from './ModelWorkspace.svelte';
  import ModelNavRail from './ModelNavRail.svelte';
  import VoiceSection from './sections/VoiceSection.svelte';
  import ThisComputerSection from './sections/ThisComputerSection.svelte';
  import ProviderDetail from './sections/ProviderDetail.svelte';
  import type { ModelHubSection } from '$lib/utils/model-hub-routing';
  import type { ModelHubTab } from '$lib/types/model-hub';

  type NavSection = ModelHubSection;
  let activeSection = $state<NavSection>('models');
  let modelTab = $state<ModelHubTab>(rememberedModelTab);
  let voiceMode = $state<'tts' | 'stt'>('tts');
  let hasRuntime = $state(false);

  const MODEL_AUTO_LOAD_KEY = 'flaxeo_modelhub_autoload';
  let modelAutoLoad = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem(MODEL_AUTO_LOAD_KEY) === '1'
  );

  function setModelAutoLoad(value: boolean) {
    modelAutoLoad = value;
    try {
      localStorage.setItem(MODEL_AUTO_LOAD_KEY, value ? '1' : '0');
    } catch { /* private mode */ }
  }

  // ── Model Providers nav (Jan grammar) ─────────────────────────────────
  let selectedProviderId = $state(DEFAULT_PROVIDER_ID);
  let addModalOpen = $state(false);
  let newEndpointLabel = $state('');
  let newEndpointUrl = $state('');
  let newEndpointKey = $state('');
  let addingEndpoint = $state(false);

  function openAddModal() {
    newEndpointLabel = '';
    newEndpointUrl = '';
    newEndpointKey = '';
    addModalOpen = true;
  }

  function closeAddModal() {
    addModalOpen = false;
  }

  const settingsNavItems = $derived([
    { id: 'general' as NavSection, label: $t('settingsNav.general'), icon: Settings, active: false },
    { id: 'search' as NavSection, label: $t('settingsNav.search'), icon: Search, active: false },
    { id: 'artifacts' as NavSection, label: $t('settingsNav.artifacts'), icon: Shapes, active: false },
    { id: 'local' as NavSection, label: $t('settingsNav.local'), icon: Cpu, active: hasRuntime },
    { id: 'voice' as NavSection, label: $t('settingsNav.voice'), icon: Volume2, active: false },
    { id: 'accessibility' as NavSection, label: $t('settingsNav.accessibility'), icon: Accessibility, active: false },
  ]);

  const isModelSection = $derived(activeSection === 'models' || activeSection === 'explore' || activeSection === 'loaded');
  const isProvidersSection = $derived(activeSection === 'providers');
  const navAriaLabel = $derived($t('settingsNav.label'));

  /** Legacy providers.custom config surfaces as a row so nothing is orphaned. */
  const legacyCustomEntry = $derived.by(() => {
    if ((appStore.config.llm?.custom_providers ?? []).some((p) => p.id === 'custom')) return null;
    const saved = appStore.config.llm?.providers?.custom;
    if (!saved || (!saved.has_api_key && !saved.api_key && !saved.model)) return null;
    return { id: 'custom', label: $t('settingsNav.customEndpoint'), base_url: '' };
  });

  const localProviderItems = $derived(CLOUD_PROVIDERS.filter((p) => p.group === 'local' && p.id !== 'custom'));
  const remoteProviderItems = $derived([
    ...CLOUD_PROVIDERS.filter((p) => p.group === 'cloud'),
    ...(legacyCustomEntry ? [legacyCustomEntry] : []),
    ...(appStore.config.llm?.custom_providers ?? [])
  ]);

  function providerStatus(id: string): 'in-use' | 'ready' | 'none' {
    if (appStore.backendMode === 'api' && appStore.activeProviderName === id) return 'in-use';
    return isProviderConfigured(appStore.config, id) ? 'ready' : 'none';
  }

  function providerLabelOf(id: string): string {
    return CLOUD_PROVIDERS.find((p) => p.id === id)?.label
      ?? appStore.config.llm?.custom_providers?.find((p) => p.id === id)?.label
      ?? (id === 'custom' ? $t('settingsNav.customEndpoint') : id);
  }

  function selectProvider(id: string) {
    selectedProviderId = id;
    activeSection = 'providers';
  }

  function defaultProviderSelection(): string {
    const active = appStore.activeProviderName;
    if (active && appStore.backendMode === 'api') return active;
    const firstConfigured = [...remoteProviderItems, ...localProviderItems]
      .find((p) => appStore.config.llm?.providers?.[p.id]?.has_api_key || appStore.config.llm?.providers?.[p.id]?.model);
    return firstConfigured?.id ?? DEFAULT_PROVIDER_ID;
  }

  async function submitNewEndpoint() {
    const name = newEndpointLabel.trim();
    const url = newEndpointUrl.trim();
    if (!name || !url || addingEndpoint) return;
    addingEndpoint = true;
    try {
      const id = await appStore.addCustomProvider({ label: name, base_url: url });
      const key = newEndpointKey.trim();
      if (key) {
        await appStore.updateProvider({ provider: id, api_key: key }, { activate: false });
      }
      closeAddModal();
      selectProvider(id);
      toastStore.success($t(key ? 'settingsNav.endpointAddedReady' : 'settingsNav.endpointAdded', { values: { name } }));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      addingEndpoint = false;
    }
  }

  // Downloads landing finished jobs → refresh model indexes once per job.
  const refreshedJobIds = new Set<string>();
  $effect(() => {
    const doneJobs = downloadsStore.jobs.filter((j) => j.status === 'done');
    let needsRefresh = false;
    for (const job of doneJobs) {
      if (!refreshedJobIds.has(job.id)) {
        refreshedJobIds.add(job.id);
        needsRefresh = true;
      }
    }
    if (needsRefresh) {
      void modelsStore.refreshStatus();
      void appStore.refreshModels();
    }
  });

  function close() {
    appStore.modelManagerOpen = false;
  }

  function resolveSection(section: string): NavSection {
    if (section === 'whisper') voiceMode = 'stt';
    if (section === 'voices') voiceMode = 'tts';
    if (section === 'explore') {
      modelTab = 'discover';
      return 'models';
    }
    if (section === 'library') {
      modelTab = 'library';
      return 'models';
    }
    if (section === 'loaded') {
      modelTab = 'active';
      return 'models';
    }
    if (section === 'providers') {
      untrack(() => { selectedProviderId = defaultProviderSelection(); });
      return 'providers';
    }
    return resolveModelHubSection(section) as NavSection;
  }

  onMount(() => {
    downloadsStore.startPolling();
    void getInstalledRuntimes().then(r => { hasRuntime = (r.runtimes?.length ?? 0) > 0; }).catch(() => {});
    const openSection = appStore.modelManagerOpenSection;
    if (openSection) {
      appStore.modelManagerOpenSection = null;
      untrack(() => { activeSection = resolveSection(openSection); });
    }
  });

  $effect(() => {
    rememberedModelTab = modelTab;
  });

  $effect(() => {
    const openSection = appStore.modelManagerOpenSection;
    if (!openSection) return;
    appStore.modelManagerOpenSection = null;
    activeSection = resolveSection(openSection);
  });
</script>

<div
  role="presentation"
  class="aui-modal-backdrop !p-2 sm:!p-4"
  use:modalLayer={{ onclose: close }}
  transition:motionFade={{ duration: 220 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-label={$t('settingsNav.dialogLabel')}
    tabindex="-1"
    class="relative flex h-[min(780px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-popover text-foreground shadow-[shadow:var(--shadow-xl)] max-sm:h-[calc(100vh-1rem)] max-sm:w-[calc(100vw-1rem)]"
    transition:flyAndScale={{ y: 8, start: 0.98, duration: 240 }}
  >
    {#snippet modalClose()}
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="aui-icon-button size-8 hover:text-[var(--error)]"
          onclick={close}
          aria-label={$t('settingsNav.close')}
        >
          <X class="size-3.5" />
        </button>
      </div>
    {/snippet}

    <!-- Close floats over the content: no empty title bar above the page. -->
    <div class="absolute right-3 top-3 z-20">{@render modalClose()}</div>

    {#if isModelSection}
      <!-- Models: rail spans full modal height; no title bar — close floats
           top-right with no divider. -->
      <div class="flex min-h-0 flex-1 flex-row overflow-hidden">
        <ModelNavRail
          tab={modelTab}
          autoLoad={modelAutoLoad}
          onselecttab={(next) => { modelTab = next; }}
          onautoload={(next) => setModelAutoLoad(next)}
        />
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ModelWorkspace bind:tab={modelTab} bind:autoLoad={modelAutoLoad} />
        </div>
      </div>
    {:else}
    <!-- Settings: no top title bar — the nav spans the full modal height and
         the close floats top-right over the content with no divider. -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <aside class="shrink-0 border-b border-[var(--border)] px-3 py-2 md:w-[220px] md:border-b-0 md:border-r md:px-3 md:py-5">
        <p class="hidden px-2.5 pb-3 text-[15px] font-semibold tracking-[-0.01em] text-foreground md:block">{$t('settingsNav.title')}</p>
        <nav class="flex gap-1 overflow-x-auto md:flex-col md:overflow-y-auto md:overflow-x-visible" aria-label={navAriaLabel}>
          {#each settingsNavItems as item}
            <button
              type="button"
              class={`nav-row flex min-w-max items-center gap-2.5 md:min-w-0 ${activeSection === item.id ? 'is-active' : ''}`}
              aria-current={activeSection === item.id ? 'page' : undefined}
              onclick={() => (activeSection = item.id)}
            >
              <item.icon class="size-4 shrink-0 text-current" />
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5 truncate">
                  <span class="truncate">{item.label}</span>
                  {#if item.active}
                    <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]"></span>
                  {/if}
                </span>
              </span>
            </button>
          {/each}

          <!-- Model Providers group -->
          <div class="min-w-max md:min-w-0 md:mt-3 md:border-t md:border-[var(--border-subtle)] md:pt-3">
            <div class="flex items-center justify-between gap-2 px-2.5 pb-1">
              <span class="text-[11px] font-semibold text-muted-foreground">{$t('settingsNav.providers')}</span>
              <button
                type="button"
                class="flex size-5 items-center justify-center rounded-md text-muted-foreground transition hover:bg-[var(--surface-hover)] hover:text-foreground"
                onclick={openAddModal}
                title={$t('settingsNav.addEndpoint')}
                aria-label={$t('settingsNav.addEndpoint')}
              >
                <Plus class="size-3.5" />
              </button>
            </div>

            {#snippet providerGroup(title: string | null, items: Array<{ id: string; label: string }>)}
              {#if title}
                <p class="mt-2 px-2.5 text-[10px] font-medium text-muted-foreground/80">{title}</p>
              {/if}
              {#each items as p (p.id)}
                {@const selected = isProvidersSection && selectedProviderId === p.id}
                {@const status = providerStatus(p.id)}
                <button
                  type="button"
                  class={`nav-row flex w-full min-w-max items-center gap-2.5 md:min-w-0 ${selected ? 'is-active' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  onclick={() => selectProvider(p.id)}
                >
                  <ProviderIcon provider={p.id} size={18} />
                  <span class="min-w-0 flex-1 truncate text-left">{providerLabelOf(p.id)}</span>
                  {#if status === 'in-use'}
                    <span class="mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" title={$t('settingsNav.inUse')}></span>
                  {:else if status === 'ready'}
                    <span class="mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-muted)] opacity-60" title={$t('settingsNav.connected')}></span>
                  {/if}
                </button>
              {/each}
            {/snippet}

            {@render providerGroup($t('settingsNav.cloud'), remoteProviderItems)}
            {@render providerGroup($t('settingsNav.onDevice'), localProviderItems)}
          </div>
        </nav>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">

        <main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
        {#if activeSection === 'voice'}
          <VoiceSection bind:voiceMode />
        {:else if activeSection === 'general'}
          <UnifiedSettingsPanel activeTab="General" />
        {:else if activeSection === 'search'}
          <UnifiedSettingsPanel activeTab="Search" />
        {:else if activeSection === 'artifacts'}
          <SettingsPage title={$t('artifacts.typesTitle')} description={$t('artifacts.typesHint')}>
            <ArtifactTypesPanel />
          </SettingsPage>
        {:else if activeSection === 'providers'}
          {#key selectedProviderId}<ProviderDetail providerId={selectedProviderId} />{/key}
        {:else if activeSection === 'local'}
          <ThisComputerSection />
        {:else if activeSection === 'accessibility'}
          <AccessibilitySettings />
        {/if}
        </main>
      </div>
    </div>
    {/if}

    {#if addModalOpen}
      <Dialog title={$t('settingsNav.addEndpointTitle')} description={$t('settingsNav.addEndpointHint')} size="sm" onclose={closeAddModal}>
        <form
          id="add-endpoint-form"
          class="space-y-3 px-5 py-4"
          onsubmit={(e) => { e.preventDefault(); void submitNewEndpoint(); }}
        >
          <label class="block space-y-1.5">
            <span class="text-xs font-medium text-muted-foreground">{$t('settingsNav.endpointName')}</span>
            <Input bind:value={newEndpointLabel} placeholder={$t('settingsNav.endpointNamePlaceholder')} autocomplete="off" autofocus />
          </label>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium text-muted-foreground">{$t('providers.baseUrl')}</span>
            <Input bind:value={newEndpointUrl} placeholder="https://api.example.com/v1" inputmode="url" autocomplete="off" spellcheck="false" />
          </label>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium text-muted-foreground">{$t('providers.apiKey')} <span class="font-normal opacity-70">· {$t('providers.optional')}</span></span>
            <Input type="password" bind:value={newEndpointKey} placeholder="sk-…" autocomplete="off" />
          </label>
        </form>
        {#snippet footer()}
          <Button variant="ghost" onclick={closeAddModal}>{$t('providers.cancel')}</Button>
          <Button type="submit" form="add-endpoint-form" loading={addingEndpoint} disabled={!newEndpointLabel.trim() || !newEndpointUrl.trim()}>
            {$t('settingsNav.addEndpointAction')}
          </Button>
        {/snippet}
      </Dialog>
    {/if}
  </div>
</div>

<style>
  /* Nav rows: quiet, the same size in both rails. Active is a soft fill,
     never a ring; the focus ring only shows for keyboard focus. */
  :global(.nav-row) {
    height: 1.75rem;
    padding: 0 0.625rem;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    outline: none;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  :global(.nav-row:hover) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  :global(.nav-row.is-active) {
    background: var(--surface-active);
    color: var(--foreground);
  }

  :global(.nav-row:focus-visible) {
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ring) 45%, transparent);
  }
</style>
