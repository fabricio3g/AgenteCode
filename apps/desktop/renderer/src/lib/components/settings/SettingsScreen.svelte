<svelte:options runes={true} />

<!--
  Settings: a screen in the shell, not a card floating over it.

  It used to be `ModelHubModal` — a dimmed, blurred backdrop with a 1120×780
  popover on top of the whole app. Now it occupies the content area the chat
  conversation normally has, with the sidebar and title bar still live. Two
  things follow from that: the surface underneath is never unmounted (a trip to
  Settings costs no scroll position and no streaming turn), and a long settings
  page uses the whole window instead of scrolling inside a letterboxed box.

  The rail (`SettingsRail`) renders the navigation model built here, so a label
  has one owner: the header names the active row from the same list.
-->

<script module lang="ts">
  import type { ModelHubTab } from '$lib/types/model-hub';
  // The rail owns the section vocabulary; the module script's types are in
  // scope for the instance script below.
  import type { SettingsSection } from './SettingsRail.svelte';

  // Where the screen reopens. Kept across mounts so Ctrl+, returns you to the
  // section you left, not always General.
  let rememberedSection: SettingsSection = 'general';
  let rememberedModelTab: ModelHubTab = 'discover';
</script>

<script lang="ts">
  import { Accessibility, Box, Compass, Cpu, Layers, Search as SearchIcon, Settings as SettingsIcon, Shapes, Volume2 } from 'lucide-svelte';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Dialog, Input } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { getInstalledRuntimes } from '$lib/services/files';
  import { cloudProviders, isProviderConfigured, providerMeta } from '$lib/utils/providers';
  import { DEFAULT_PROVIDER_ID } from '$shared/providers';
  import { resolveModelHubRoute } from '$lib/utils/model-hub-routing';
  import AccessibilitySettings from './AccessibilitySettings.svelte';
  import ArtifactTypesPanel from './ArtifactTypesPanel.svelte';
  import DomainsSettings from './DomainsSettings.svelte';
  import ModelWorkspace from './ModelWorkspace.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsRail, { type RailGroup, type RailItem } from './SettingsRail.svelte';
  import ProviderDetail from './sections/ProviderDetail.svelte';
  import ThisComputerSection from './sections/ThisComputerSection.svelte';
  import VoiceSection from './sections/VoiceSection.svelte';
  import UnifiedSettingsPanel from './UnifiedSettingsPanel.svelte';

  const MODEL_AUTO_LOAD_KEY = 'flaxeo_modelhub_autoload';

  let activeSection = $state<SettingsSection>(rememberedSection);
  let modelTab = $state<ModelHubTab>(rememberedModelTab);
  let voiceMode = $state<'tts' | 'stt'>('tts');
  let hasRuntime = $state(false);
  let selectedProviderId = $state(DEFAULT_PROVIDER_ID);
  let modelAutoLoad = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem(MODEL_AUTO_LOAD_KEY) === '1'
  );

  // ── Add endpoint ─────────────────────────────────────────────────────
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

  async function submitNewEndpoint() {
    const name = newEndpointLabel.trim();
    const url = newEndpointUrl.trim();
    if (!name || !url || addingEndpoint) return;
    addingEndpoint = true;
    try {
      const id = await appStore.addCustomProvider({ label: name, base_url: url });
      const key = newEndpointKey.trim();
      if (key) await appStore.updateProvider({ provider: id, api_key: key }, { activate: false });
      addModalOpen = false;
      selectedProviderId = id;
      activeSection = 'providers';
      toastStore.success($t(key ? 'settingsNav.endpointAddedReady' : 'settingsNav.endpointAdded', { values: { name } }));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      addingEndpoint = false;
    }
  }

  // "Load after download" lives on the Explore page now; remember it here.
  $effect(() => {
    const value = modelAutoLoad;
    try {
      localStorage.setItem(MODEL_AUTO_LOAD_KEY, value ? '1' : '0');
    } catch { /* private mode */ }
  });

  // ── Navigation ───────────────────────────────────────────────────────
  function routeItem(item: RailItem) {
    if (item.kind === 'provider') {
      selectedProviderId = item.id;
      activeSection = 'providers';
      return;
    }
    if (item.kind === 'tab') {
      modelTab = item.id;
      activeSection = 'models';
      return;
    }
    activeSection = item.id;
    if (item.id === 'voice') voiceMode = 'tts';
  }

  function isSelected(item: RailItem): boolean {
    if (item.kind === 'provider') return activeSection === 'providers' && item.id === selectedProviderId;
    if (item.kind === 'tab') return activeSection === 'models' && item.id === modelTab;
    return activeSection === item.id;
  }

  // Legacy deep links ('whisper' → voice with stt, 'explore' → Models →
  // Discover) still name a route rather than a section.
  function applySection(section: string) {
    if (section === 'whisper') voiceMode = 'stt';
    if (section === 'voices') voiceMode = 'tts';
    const route = resolveModelHubRoute(section);
    activeSection = route.section;
    if (route.modelTab) modelTab = route.modelTab;
    if (route.section === 'providers') selectedProviderId = defaultProviderSelection();
  }

  // ── Providers ────────────────────────────────────────────────────────
  /** Legacy providers.custom config surfaces as a row so nothing is orphaned. */
  const legacyCustomEntry = $derived.by(() => {
    if ((appStore.config.llm?.custom_providers ?? []).some((p) => p.id === 'custom')) return null;
    const saved = appStore.config.llm?.providers?.custom;
    if (!saved || (!saved.has_api_key && !saved.api_key && !saved.model)) return null;
    return { id: 'custom', label: $t('settingsNav.customEndpoint') };
  });

  function providerLabelOf(id: string): string {
    return providerMeta(id)?.label
      ?? appStore.config.llm?.custom_providers?.find((p) => p.id === id)?.label
      ?? (id === 'custom' ? $t('settingsNav.customEndpoint') : id);
  }

  function providerStatus(id: string): 'in-use' | 'ready' | 'none' {
    if (appStore.backendMode === 'api' && appStore.activeProviderName === id) return 'in-use';
    return isProviderConfigured(appStore.config, id) ? 'ready' : 'none';
  }

  function providerItem(id: string): RailItem {
    return { kind: 'provider', id, label: providerLabelOf(id), status: providerStatus(id) };
  }

  function defaultProviderSelection(): string {
    const active = appStore.activeProviderName;
    if (active && appStore.backendMode === 'api') return active;
    const firstConfigured = [...cloudProviders(), ...(appStore.config.llm?.custom_providers ?? [])]
      .find((p) => appStore.config.llm?.providers?.[p.id]?.has_api_key || appStore.config.llm?.providers?.[p.id]?.model);
    return firstConfigured?.id ?? DEFAULT_PROVIDER_ID;
  }

  const activeDownloads = $derived(downloadsStore.jobs.filter((job) => ['queued', 'running'].includes(job.status)).length);

  const groups = $derived<RailGroup[]>([
    {
      id: 'models',
      title: $t('settingsNav.groupModels'),
      items: [
        { kind: 'tab', id: 'discover', label: $t('modelHub.navExplore'), icon: Compass },
        { kind: 'tab', id: 'library', label: $t('modelHub.navLibrary'), icon: Layers, count: activeDownloads },
        { kind: 'tab', id: 'active', label: $t('modelHub.navRunning'), icon: Box, dot: !!modelsStore.status?.active_model }
      ]
    },
    {
      id: 'preferences',
      title: $t('settingsNav.groupPreferences'),
      items: [
        { kind: 'section', id: 'general', label: $t('settingsNav.general'), icon: SettingsIcon },
        { kind: 'section', id: 'search', label: $t('settingsNav.search'), icon: SearchIcon },
        { kind: 'section', id: 'artifacts', label: $t('settingsNav.artifacts'), icon: Shapes },
        { kind: 'section', id: 'domains', label: 'Domains', icon: Layers },
        // The dot marks sections that depend on something installed.
        { kind: 'section', id: 'local', label: $t('settingsNav.local'), icon: Cpu, dot: hasRuntime },
        { kind: 'section', id: 'voice', label: $t('settingsNav.voice'), icon: Volume2 },
        { kind: 'section', id: 'accessibility', label: $t('settingsNav.accessibility'), icon: Accessibility }
      ]
    },
    {
      id: 'providers',
      title: $t('settingsNav.providers'),
      items: [],
      subgroups: [
        { title: $t('settingsNav.cloud'), items: cloudProviders().filter((p) => p.group === 'cloud').map((p) => providerItem(p.id)).concat(legacyCustomEntry ? [providerItem(legacyCustomEntry.id)] : [], (appStore.config.llm?.custom_providers ?? []).map((p) => providerItem(p.id))) },
        { title: $t('settingsNav.onDevice'), items: cloudProviders().filter((p) => p.group === 'local' && p.id !== 'custom').map((p) => providerItem(p.id)) }
      ]
    }
  ]);

  const selectedRow = $derived(
    groups.flatMap((group) => group.subgroups?.flatMap((sub) => sub.items) ?? group.items)
      .find(isSelected) ?? null
  );

  function onMountRuntimes() {
    downloadsStore.startPolling();
    void getInstalledRuntimes().then((r) => { hasRuntime = (r.runtimes?.length ?? 0) > 0; }).catch(() => {});
  }

  onMount(() => {
    onMountRuntimes();
    const requested = appStore.settingsScreenSection;
    if (requested) {
      appStore.settingsScreenSection = null;
      untrack(() => applySection(requested));
    }
  });

  // A deep link can land after the screen is already up (the legacy flags are
  // effects, not call sites).
  $effect(() => {
    const requested = appStore.settingsScreenSection;
    if (!requested) return;
    appStore.settingsScreenSection = null;
    applySection(requested);
  });

  $effect(() => {
    rememberedSection = activeSection;
    rememberedModelTab = modelTab;
  });
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={$t('settingsNav.title')}>
  <!-- No header here: the rail names every row and each panel titles itself,
       so a screen-level bar only repeats where you are. Back lives in the
       title bar, where the buttons it displaced used to sit. -->
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
    <SettingsRail
      groups={groups}
      selected={selectedRow ? `${selectedRow.kind}:${selectedRow.id}` : ''}
      onselect={routeItem}
      onaddendpoint={openAddModal}
    />

    <div class="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
      {#if activeSection === 'models'}
        <ModelWorkspace bind:tab={modelTab} bind:autoLoad={modelAutoLoad} />
      {:else if activeSection === 'voice'}
        <VoiceSection bind:voiceMode />
      {:else if activeSection === 'general'}
        <UnifiedSettingsPanel activeTab="General" />
      {:else if activeSection === 'search'}
        <UnifiedSettingsPanel activeTab="Search" />
      {:else if activeSection === 'artifacts'}
        <SettingsPage title={$t('artifacts.typesTitle')} description={$t('artifacts.typesHint')}>
          <ArtifactTypesPanel />
        </SettingsPage>
      {:else if activeSection === 'domains'}
        <DomainsSettings />
      {:else if activeSection === 'providers'}
        {#key selectedProviderId}<ProviderDetail providerId={selectedProviderId} />{/key}
      {:else if activeSection === 'local'}
        <ThisComputerSection />
      {:else if activeSection === 'accessibility'}
        <AccessibilitySettings />
      {/if}
    </div>
  </div>
</section>

{#if addModalOpen}
  <!-- Still a dialog: it interrupts the screen, so it dims and traps Escape
       the way every other dialog does. -->
  <Dialog title={$t('settingsNav.addEndpointTitle')} description={$t('settingsNav.addEndpointHint')} size="sm" onclose={() => (addModalOpen = false)}>
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
        <Input type="text" bind:value={newEndpointUrl} placeholder="https://api.example.com/v1" inputmode="url" autocomplete="off" spellcheck="false" />
      </label>
      <label class="block space-y-1.5">
        <span class="text-xs font-medium text-muted-foreground">{$t('providers.apiKey')} <span class="font-normal opacity-70">· {$t('providers.optional')}</span></span>
        <Input type="password" bind:value={newEndpointKey} placeholder="sk-…" autocomplete="off" />
      </label>
    </form>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (addModalOpen = false)}>{$t('providers.cancel')}</Button>
      <Button type="submit" form="add-endpoint-form" loading={addingEndpoint} disabled={!newEndpointLabel.trim() || !newEndpointUrl.trim()}>
        {$t('settingsNav.addEndpointAction')}
      </Button>
    {/snippet}
  </Dialog>
{/if}
