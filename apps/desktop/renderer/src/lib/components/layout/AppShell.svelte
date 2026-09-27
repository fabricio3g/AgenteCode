<svelte:options runes={true} />

<script lang="ts">
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import Titlebar from '$lib/components/layout/Titlebar.svelte';
  import Sidebar from '$lib/components/layout/Sidebar.svelte';
  import HomeSurface from '$lib/features/home/HomeSurface.svelte';
  import CodeSurface from '$lib/features/code/CodeSurface.svelte';
  import ArtifactsScreen from '$lib/features/artifacts/ArtifactsScreen.svelte';
  import ArtifactPanel from '$lib/features/artifacts/ArtifactPanel.svelte';
  import RoleplaySurface from '$lib/features/roleplay/RoleplaySurface.svelte';
  import { charactersStore } from '$lib/features/roleplay/characters.svelte';
  import { worldsStore } from '$lib/features/roleplay/worlds.svelte';
  import { ensureStarterKit, starterKitStore } from '$lib/features/roleplay/starter-kit';
  import { codeStore } from '$lib/features/code/code.svelte';
  import SystemPromptModal from '$lib/components/settings/SystemPromptModal.svelte';
  import LocalModelLoadModal from '$lib/components/settings/LocalModelLoadModal.svelte';
  import ModelHubModal from '$lib/components/settings/ModelHubModal.svelte';
  import ArtifactStudioModal from '$lib/components/agent/ArtifactStudioModal.svelte';
  import Toaster from '$lib/components/layout/Toaster.svelte';
  import ConfirmDialog from '$lib/components/layout/ConfirmDialog.svelte';
  import LLMDrawer from '$lib/components/layout/LLMDrawer.svelte';
  import ChatSearchModal from '$lib/components/layout/ChatSearchModal.svelte';
  import SearchSidebar from '$lib/components/search/SearchSidebar.svelte';
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ResizeHandle from '$lib/components/ui/ResizeHandle.svelte';
  import { Plus, Boxes, Settings } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { capabilitiesStore } from '$lib/stores/capabilities.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { copy } from '$lib/copy';
  import { legacyFlagToModelHubSection, resolveModelHubSection } from '$lib/utils/model-hub-routing';
  import { downloadSessionMarkdown } from '$lib/features/shared/export-session';
  import { formatShortcut, isMacPlatform } from '$lib/utils/shortcuts';

  let showShortcutsHelp = $state(false);
  const inCodeSpace = $derived(appStore.activeSpace === 'code');
  const inRoleplaySpace = $derived(appStore.activeSpace === 'roleplay');
  /** Ctrl/⌘+K means "new" in every space — a chat, a roleplay, or a project. */
  const shortcutRows = $derived<Array<[string, string]>>([
    ['mod+k', inCodeSpace ? $t('shortcuts.addProject') : inRoleplaySpace ? copy.roleplay.newRoleplay : $t('shortcuts.newChat')],
    ['mod+shift+k', $t('shortcuts.search')],
    ['mod+,', $t('shortcuts.settings')],
    ['mod+b', $t('shortcuts.sidebar')],
    ...(inCodeSpace ? [] : ([['mod+`', $t('shortcuts.artifactStudio')]] as Array<[string, string]>)),
    ['mod+e', $t('shortcuts.export')],
    ['F2', $t('shortcuts.rename')],
    ['mod+?', $t('shortcuts.help')],
    ['escape', $t('shortcuts.escape')]
  ]);
  const newSessionLabel = $derived(
    inCodeSpace ? $t('code.addProject') : inRoleplaySpace ? copy.roleplay.newRoleplay : $t('shortcuts.newChat')
  );

  function startNewSession() {
    if (inCodeSpace) {
      void codeStore.addProject();
      return;
    }
    appStore.createChat(appStore.activeSpace);
  }


  function openModelHub(section: string = 'models') {
    appStore.modelManagerOpenSection = resolveModelHubSection(section);
    appStore.modelManagerOpen = true;
  }

  function handleKeydown(event: KeyboardEvent) {
    const ctrl = isMacPlatform() ? event.metaKey : event.ctrlKey;
    const target = event.target as HTMLElement;
    const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    if (ctrl && event.key === 'k' && !event.shiftKey) {
      event.preventDefault();
      startNewSession();
      return;
    }
    if (ctrl && event.key === 'k' && event.shiftKey) {
      event.preventDefault(); appStore.chatSearchOpen = !appStore.chatSearchOpen; return;
    }
    if (ctrl && event.key === ',') {
      event.preventDefault(); openModelHub('general'); return;
    }
    if (ctrl && event.key === 'b') {
      event.preventDefault(); appStore.sidebarOpen = !appStore.sidebarOpen; return;
    }
    // Ctrl+` toggles the artifact studio
    if (ctrl && event.key === '`') {
      event.preventDefault();
      if (appStore.currentArtifact) appStore.artifactStudioOpen = !appStore.artifactStudioOpen;
      return;
    }
    if (ctrl && event.key === 'e' && !inInput) {
      event.preventDefault();
      const chat = appStore.currentChat;
      if (!chat?.messages?.length) return;
      downloadSessionMarkdown(chat);
      return;
    }
    if (event.key === '?' && ctrl) {
      event.preventDefault(); showShortcutsHelp = !showShortcutsHelp; return;
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    browserPanelStore.init();
    // Roleplay library: one query at startup, independent of the space gate.
    // The starter kit follows the loads so it can see what already exists.
    void Promise.all([charactersStore.load(), worldsStore.load()]).then(() => ensureStarterKit(starterKitStore));
    if (isElectron()) {
      void hardwareStore.refresh();
      void capabilitiesStore.refresh();
    }
    return () => document.removeEventListener('keydown', handleKeydown);
  });

  $effect(() => {
    if (!appStore.settingsOpen) return;
    appStore.settingsOpen = false;
    openModelHub(legacyFlagToModelHubSection('settingsOpen'));
  });

  $effect(() => {
    if (!appStore.runtimeManagerOpen) return;
    appStore.runtimeManagerOpen = false;
    openModelHub(legacyFlagToModelHubSection('runtimeManagerOpen'));
  });

  // ── Sidebar width (drag its edge; remembered) ────────────────────────
  const SIDEBAR_WIDTH_KEY = 'flaxeo.sidebar.width';
  function readSidebarWidth(): number {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return Number.isFinite(saved) && saved >= 200 ? saved : 240;
    } catch {
      return 240;
    }
  }
  let sidebarWidth = $state(readSidebarWidth());
  let sidebarResizing = $state(false);
  let sidebarStart = 0;

  function resizeSidebar(delta: number) {
    sidebarWidth = Math.round(Math.min(440, Math.max(200, sidebarStart + delta)));
  }

  function endSidebarResize() {
    sidebarResizing = false;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Blocked storage: the width lasts for this session.
    }
  }
</script>

<div class="flex h-full overflow-hidden bg-background text-foreground">
  <!-- Full-height sidebar (Flaxeo pattern): sidebar | titlebar+main -->
  <div
    class="sidebar-outer relative flex shrink-0 flex-col overflow-hidden border-r border-[var(--sidebar-border)] bg-sidebar"
    class:expanded={appStore.sidebarOpen}
    class:resizing={sidebarResizing}
    style="--sidebar-w: {sidebarWidth}px"
  >
    <div class="sidebar-view-full absolute inset-0 flex flex-col">
      <Sidebar />
    </div>

    <!-- pt-0.5 centres the first 2rem control inside the titlebar's 2.25rem
         row, so the collapsed rail keeps the same baseline as the titlebar. -->
    <div class="sidebar-view-collapsed absolute inset-0 flex flex-col items-center gap-0.5 px-2 pt-0.5">
      <Tooltip label={newSessionLabel}>
        <button
          class="aui-icon-button size-8"
          onclick={startNewSession}
          aria-label={newSessionLabel}
        >
          <Plus class="size-4" />
        </button>
      </Tooltip>

      <div class="flex-1"></div>

      <Tooltip label={$t('sidebar.models')}>
        <button
          class="aui-icon-button size-8"
          onclick={() => openModelHub('models')}
          aria-label={$t('sidebar.models')}
        >
          <Boxes class="size-4" />
        </button>
      </Tooltip>
      <Tooltip label={$t('sidebar.settings')}>
        <button
          class="aui-icon-button size-8 mb-1"
          onclick={() => openModelHub('general')}
          aria-label={$t('sidebar.settings')}
        >
          <Settings class="size-4" />
        </button>
      </Tooltip>
    </div>
  </div>

  {#if appStore.sidebarOpen}
    <ResizeHandle
      axis="x"
      label={$t('shortcuts.resizeSidebar')}
      onstart={() => { sidebarStart = sidebarWidth; sidebarResizing = true; }}
      onresize={resizeSidebar}
      onend={endSidebarResize}
    />
  {/if}

  <!-- No overflow-hidden on this column: titlebar fade hangs below h-9. -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
    <Titlebar />

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <!-- The one branch point between the spaces:
           Code hosts the coding agent surface; Roleplay the character surface;
           Home keeps the general chat panel. -->
      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {#if inCodeSpace}
          <CodeSurface />
        {:else if appStore.homeView === 'artifacts'}
          <ArtifactsScreen />
        {:else if inRoleplaySpace}
          <RoleplaySurface />
        {:else}
          <HomeSurface />
        {/if}
      </div>
      {#if !inCodeSpace && appStore.homeView === 'chat' && appStore.artifactPanel}
        <ArtifactPanel />
      {/if}
      {#if browserPanelStore.open}
        <BrowserPanel />
      {/if}
    </div>
  </div>
</div>

{#if appStore.promptConfigOpen}
  <SystemPromptModal />
{/if}
<LocalModelLoadModal />

{#if appStore.modelManagerOpen}
  <ModelHubModal />
{/if}


<Toaster />
<ConfirmDialog />
<LLMDrawer />

{#if appStore.artifactStudioOpen && appStore.currentArtifact}
  <ArtifactStudioModal />
{/if}

{#if appStore.chatSearchOpen}
  <ChatSearchModal />
{/if}

{#if appStore.searchSidebarOpen}
  <SearchSidebar />
{/if}

{#if appStore.onboardingOpen}
  <OnboardingWizard />
{/if}

{#if showShortcutsHelp}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="aui-modal-backdrop" use:modalLayer={{ onclose: () => (showShortcutsHelp = false) }} onclick={() => (showShortcutsHelp = false)}>
    <div
      class="w-full max-w-sm rounded-lg border border-border bg-popover p-6 shadow-lg"
      role="dialog" aria-modal="true" tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <h2 class="mb-4 text-base font-semibold text-foreground">{$t('shortcuts.title')}</h2>
      <dl class="space-y-3 text-sm">
        {#each shortcutRows as [combo, label] (combo)}
          <div class="flex items-center justify-between gap-4">
            <span class="text-muted-foreground">{label}</span>
            <kbd class="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{formatShortcut(combo)}</kbd>
          </div>
        {/each}
      </dl>
    </div>
  </div>
{/if}

<style>
  .sidebar-outer {
    width: 3.5rem; /* w-14 */
    transition: width var(--motion-smooth) var(--motion-ease-out);
  }
  /* Default 15rem: room for a project tree with row actions and status
     dots; dragging the edge sets --sidebar-w. */
  .sidebar-outer.expanded {
    width: var(--sidebar-w, 15rem);
  }
  .sidebar-outer.resizing {
    transition: none;
  }

  .sidebar-view-full {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    overflow: hidden;
    transition: opacity 150ms ease, visibility 0s linear 150ms;
  }
  .sidebar-outer.expanded .sidebar-view-full {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition-delay: 40ms, 0s;
  }

  .sidebar-view-collapsed {
    opacity: 1;
    visibility: visible;
    transition: opacity 120ms ease, visibility 0s linear;
  }

  .sidebar-outer.expanded .sidebar-view-collapsed {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition-delay: 0s, 120ms;
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar-outer { transition: none; will-change: auto; }
  }
</style>
