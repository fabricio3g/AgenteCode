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
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { onMount, untrack } from 'svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import {
    Plus, X,
    Search, Cpu, Volume2, Settings,
  } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { getInstalledRuntimes } from '$lib/services/files';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { CLOUD_PROVIDERS } from '$lib/utils/providers';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';
  import { resolveModelHubSection } from '$lib/utils/model-hub-routing';
  import LocalRuntimePanel from './LocalRuntimePanel.svelte';
  import UnifiedSettingsPanel from './UnifiedSettingsPanel.svelte';
  import HardwareSummary from './VoiceSettings.svelte';
  import ModelWorkspace from './ModelWorkspace.svelte';
  import ModelNavRail from './ModelNavRail.svelte';
  import VoiceSection from './sections/VoiceSection.svelte';
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
  let selectedProviderId = $state('openai');
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
    { id: 'general' as NavSection, label: 'General', description: 'Profile and chat behavior', icon: Settings, active: false },
    { id: 'search' as NavSection, label: 'Search', description: 'Web search providers', icon: Search, active: false },
    { id: 'local' as NavSection, label: 'Local Runtime', description: 'Hardware and local engine', icon: Cpu, active: hasRuntime },
    { id: 'voice' as NavSection, label: 'Voice', description: 'Speech output and input', icon: Volume2, active: false },
  ]);

  const isModelSection = $derived(activeSection === 'models' || activeSection === 'explore' || activeSection === 'loaded');
  const isProvidersSection = $derived(activeSection === 'providers');
  const navAriaLabel = $derived('Settings sections');

  /** Legacy providers.custom config surfaces as a row so nothing is orphaned. */
  const legacyCustomEntry = $derived.by(() => {
    if ((appStore.config.llm?.custom_providers ?? []).some((p) => p.id === 'custom')) return null;
    const saved = appStore.config.llm?.providers?.custom;
    if (!saved || (!saved.has_api_key && !saved.api_key && !saved.model)) return null;
    return { id: 'custom', label: 'Custom / Other', base_url: '' };
  });

  const localProviderItems = $derived(CLOUD_PROVIDERS.filter((p) => p.group === 'local' && p.id !== 'custom'));
  const remoteProviderItems = $derived([
    ...CLOUD_PROVIDERS.filter((p) => p.group === 'cloud'),
    ...(legacyCustomEntry ? [legacyCustomEntry] : []),
    ...(appStore.config.llm?.custom_providers ?? [])
  ]);

  function providerLabelOf(id: string): string {
    return CLOUD_PROVIDERS.find((p) => p.id === id)?.label
      ?? appStore.config.llm?.custom_providers?.find((p) => p.id === id)?.label
      ?? (id === 'custom' ? 'Custom / Other' : id);
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
    return firstConfigured?.id ?? 'openai';
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
      toastStore.success(key ? `${name} added and ready` : `${name} added — add your API key to finish setup`);
    } catch (err) {
      toastStore.error('Failed to add endpoint: ' + ((err as Error)?.message || String(err)));
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
    aria-label="Models and settings"
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
          aria-label="Close"
        >
          <X class="size-3.5" />
        </button>
      </div>
    {/snippet}

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
          <div class="flex h-14 shrink-0 items-center justify-end px-4 sm:px-5">
            {@render modalClose()}
          </div>

          <ModelWorkspace bind:tab={modelTab} bind:autoLoad={modelAutoLoad} />
        </div>
      </div>
    {:else}
    <!-- Settings: no top title bar — the nav spans the full modal height and
         the close floats top-right over the content with no divider. -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <aside class="shrink-0 border-b border-[var(--border-subtle)] bg-muted/20 px-3 py-2 md:w-[216px] md:border-b-0 md:border-r md:px-3 md:py-4">
        <nav class="flex gap-1 overflow-x-auto md:flex-col md:overflow-y-auto md:overflow-x-visible" aria-label={navAriaLabel}>
          {#each settingsNavItems as item}
            <button
              type="button"
              class={`flex min-w-max items-center gap-2 rounded-full border-0 px-3 py-2 text-[13px] font-medium shadow-none outline-none transition-[background-color,color,box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--motion-ease)] focus-visible:ring-[3px] focus-visible:ring-ring/25 active:scale-[0.99] md:min-w-0
                ${activeSection === item.id ? 'bg-[var(--surface-active)] text-foreground' : 'text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground'}`}
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
            <div class="flex items-center justify-between gap-2 px-3 pb-1">
              <span class="text-[10px] font-semibold text-muted-foreground">Model providers</span>
              <button
                type="button"
                class="flex size-5 items-center justify-center rounded-md text-muted-foreground transition hover:bg-[var(--surface-hover)] hover:text-foreground"
                onclick={openAddModal}
                title="Add custom endpoint"
                aria-label="Add custom endpoint"
              >
                <Plus class="size-3.5" />
              </button>
            </div>

            {#snippet providerGroup(title: string | null, items: Array<{ id: string; label: string }>)}
              {#if title}
                <p class="mt-2 px-3 text-[9px] font-semibold text-muted-foreground/70">{title}</p>
              {/if}
              {#each items as p (p.id)}
                {@const selected = isProvidersSection && selectedProviderId === p.id}
                {@const routing = appStore.backendMode === 'api' && appStore.activeProviderName === p.id}
                <button
                  type="button"
                  class={`flex w-full min-w-max items-center gap-2 rounded-full border-0 px-3 py-1.5 text-[13px] font-medium outline-none transition-colors duration-[var(--motion-fast)] md:min-w-0 ${selected ? 'bg-[var(--surface-active)] text-foreground' : 'text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground'}`}
                  aria-current={selected ? 'page' : undefined}
                  onclick={() => selectProvider(p.id)}
                >
                  <ProviderIcon provider={p.id} size={18} />
                  <span class="min-w-0 flex-1 truncate text-left">{providerLabelOf(p.id)}</span>
                  {#if routing}
                    <span class="mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" title="Active route"></span>
                  {/if}
                </button>
              {/each}
            {/snippet}

            {@render providerGroup('Local', localProviderItems)}
            {@render providerGroup('Remote', remoteProviderItems)}
          </div>
        </nav>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div class="flex h-14 shrink-0 items-center justify-end px-4 sm:px-5">
          {@render modalClose()}
        </div>

        <main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
        {#if activeSection === 'voice'}
          <VoiceSection bind:voiceMode />
        {:else if activeSection === 'general'}
          <UnifiedSettingsPanel activeTab="General" />
        {:else if activeSection === 'search'}
          <UnifiedSettingsPanel activeTab="Search" />
        {:else if activeSection === 'providers'}
          <ProviderDetail providerId={selectedProviderId} />
        {:else if activeSection === 'local'}
          <div class="flex-1 overflow-y-auto bg-background">
            <div class="mx-auto max-w-[760px] space-y-5 p-5 sm:p-6">
              <div>
                <h3 class="text-lg font-semibold tracking-[-0.02em] text-foreground">Local Runtime</h3>
                <p class="mt-1 text-sm text-muted-foreground">Review available hardware and manage the local inference engine.</p>
              </div>
              <HardwareSummary />
              <LocalRuntimePanel embedded />
            </div>
          </div>
        {/if}
        </main>
      </div>
    </div>
    {/if}

    {#if addModalOpen}
      <!-- Add custom endpoint — floats over the settings dialog. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        role="presentation"
        class="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-[var(--overlay)] p-4"
        use:modalLayer={{ onclose: closeAddModal }}
        onclick={(e) => { if (e.target === e.currentTarget) closeAddModal(); }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add custom provider"
          tabindex="-1"
          class="w-[min(440px,100%)] rounded-[var(--radius-2xl)] border border-border bg-popover text-foreground shadow-[shadow:var(--shadow-xl)]"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
            <div>
              <h3 class="text-[15px] font-semibold tracking-[-0.01em]">Add custom provider</h3>
              <p class="mt-0.5 text-xs text-muted-foreground">Connect any OpenAI-compatible endpoint.</p>
            </div>
            <button
              type="button"
              class="aui-icon-button size-8 shrink-0"
              onclick={closeAddModal}
              aria-label="Close"
            >
              <X class="size-3.5" />
            </button>
          </div>
          <form
            class="space-y-3 px-5 py-4"
            onsubmit={(e) => { e.preventDefault(); void submitNewEndpoint(); }}
          >
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
              <input
                class="aui-input w-full text-sm"
                bind:value={newEndpointLabel}
                placeholder="e.g. My gateway"
                autocomplete="off"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-muted-foreground">Base URL</span>
              <input
                class="aui-input w-full text-sm"
                bind:value={newEndpointUrl}
                placeholder="https://api.example.com/v1"
                inputmode="url"
                autocomplete="off"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-muted-foreground">API key <span class="font-normal opacity-70">(optional)</span></span>
              <input
                type="password"
                class="aui-input w-full text-sm"
                bind:value={newEndpointKey}
                placeholder="sk-…"
                autocomplete="off"
              />
            </label>
            <div class="flex justify-end gap-1.5 pt-1">
              <button
                type="button"
                class="rounded-full px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition hover:text-foreground"
                onclick={closeAddModal}
              >Cancel</button>
              <button
                type="submit"
                class="rounded-full bg-[var(--primary)] px-4 py-1.5 text-[13px] font-semibold text-[var(--primary-fg)] transition disabled:opacity-50"
                disabled={!newEndpointLabel.trim() || !newEndpointUrl.trim() || addingEndpoint}
              >{addingEndpoint ? 'Adding…' : 'Add provider'}</button>
            </div>
          </form>
        </div>
      </div>
    {/if}
  </div>
</div>
