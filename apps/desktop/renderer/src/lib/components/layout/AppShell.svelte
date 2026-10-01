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
  import BotsScreen from '$lib/features/bots/BotsScreen.svelte';
  import BotRoutines from '$lib/features/bots/BotRoutines.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';
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
  import { SidebarPeek } from './sidebar-peek.svelte';
  import ResizeHandle from '$lib/components/ui/ResizeHandle.svelte';
  import RightDock, { type DockPanel } from './RightDock.svelte';
  import TitlebarLeftTools from './TitlebarLeftTools.svelte';
  import ChangesPane from '$lib/features/code/workspace/ChangesPane.svelte';
  import PlanPanel from '$lib/features/code/PlanPanel.svelte';
  import { codeWorkspace } from '$lib/features/code/workspace.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { capabilitiesStore } from '$lib/stores/capabilities.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { isElectron } from '$lib/services/bridge';
  import { copy } from '$lib/copy';
  import { legacyFlagToModelHubSection, resolveModelHubSection } from '$lib/utils/model-hub-routing';
  import { downloadSessionMarkdown } from '$lib/features/shared/export-session';
  import { formatShortcut, isMacPlatform } from '$lib/utils/shortcuts';

  let showShortcutsHelp = $state(false);
  // The top-bar tab decides the main view; Bots sits beside the three spaces.
  const inBots = $derived(appStore.activeTab === 'bots');
  const inCodeSpace = $derived(appStore.activeTab === 'code');

  // The right dock: Changes and the presented plan (Code), the open artifact
  // (Home chat) and the agent browser, stacked when more than one is open.
  const changesTarget = $derived(codeWorkspace.changesTarget);
  const showChanges = $derived(inCodeSpace && codeWorkspace.layout.changesOpen && !!changesTarget);
  /** The plan belongs to one conversation: another one open hides it. */
  const openPlan = $derived(inCodeSpace && codeWorkspace.plan?.chatId === appStore.currentChat?.id ? codeWorkspace.plan : null);
  const showArtifact = $derived(!inCodeSpace && !inBots && appStore.homeView === 'chat' && !!appStore.artifactPanel);
  const showRoutines = $derived(inBots && !!botsStore.current && botsStore.routinesOpen);
  const dockPanels = $derived.by(() => {
    const panels: DockPanel[] = [];
    if (showChanges) panels.push({ id: 'changes', content: changesPanel });
    if (openPlan) panels.push({ id: 'plan', content: planPanel });
    if (showArtifact) panels.push({ id: 'artifact', content: artifactPanel });
    if (showRoutines) panels.push({ id: 'routines', content: routinesPanel });
    if (browserPanelStore.open) panels.push({ id: 'browser', content: browserPanel, accent: browserPanelStore.agentDriving });
    return panels;
  });
  const inRoleplaySpace = $derived(appStore.activeTab === 'roleplay');
  /** Ctrl/⌘+K means "new" in every space — a chat, a roleplay, or a project. */
  const shortcutRows = $derived<Array<[string, string]>>([
    ['mod+k', inBots ? $t('bots.new') : inCodeSpace ? $t('shortcuts.addProject') : inRoleplaySpace ? copy.roleplay.newRoleplay : $t('shortcuts.newChat')],
    ['mod+shift+k', $t('shortcuts.search')],
    ['mod+,', $t('shortcuts.settings')],
    ['mod+b', $t('shortcuts.sidebar')],
    ...(inCodeSpace ? [] : ([['mod+`', $t('shortcuts.artifactStudio')]] as Array<[string, string]>)),
    ['mod+e', $t('shortcuts.export')],
    ['F2', $t('shortcuts.rename')],
    ['mod+?', $t('shortcuts.help')],
    ['escape', $t('shortcuts.escape')]
  ]);

  function startNewSession() {
    if (inBots) {
      botsStore.editor = 'new';
      return;
    }
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
      event.preventDefault(); appStore.openSearch(); return;
    }
    if (ctrl && event.key === ',') {
      event.preventDefault(); openModelHub('general'); return;
    }
    if (ctrl && event.key === 'b') {
      event.preventDefault(); toggleSidebar(); return;
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
    return () => {
      document.removeEventListener('keydown', handleKeydown);
      peek.clearTimers();
    };
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

  // One mounted sidebar: pinned takes layout space; the preview floats over
  // the content below the title bar (sidebar-peek.svelte.ts).
  const peek = new SidebarPeek(() => appStore.sidebarOpen);

  function toggleSidebar() {
    peek.toggled();
    appStore.sidebarOpen = !appStore.sidebarOpen;
  }

  $effect(() => {
    if (appStore.sidebarOpen) peek.close();
  });

  $effect(() => {
    if (!peek.open) return;
    return peek.listen(() => document.querySelector<HTMLButtonElement>('[data-sidebar-toggle]')?.focus());
  });

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

<div data-desktop-shell class="relative flex h-full overflow-hidden bg-background text-foreground">
  <!-- Full-height sidebar (Flaxeo pattern): sidebar | titlebar+main -->
  <div
    class="sidebar-outer relative flex shrink-0 flex-col bg-sidebar"
    class:expanded={appStore.sidebarOpen}
    class:resizing={sidebarResizing}
    style="--sidebar-w: {sidebarWidth}px"
  >
    <div
      bind:this={peek.panel}
      id="app-sidebar"
      class="sidebar-view-full absolute inset-0 flex flex-col"
      class:preview={!appStore.sidebarOpen && peek.open}
      inert={!appStore.sidebarOpen && !peek.open}
    >
      {#if !appStore.sidebarOpen && peek.open}
        <!-- The preview runs to the top of the window, over the title bar's
             corner, so it carries the bar's own buttons in the same spot. -->
        <div class="preview-bar"><TitlebarLeftTools expanded onToggle={toggleSidebar} /></div>
      {/if}
      <Sidebar />
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
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <Titlebar sidebarPreview={peek.open} onSidebarEnter={() => peek.show()} onSidebarLeave={(event) => peek.leave(event)} onSidebarToggle={toggleSidebar} />

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <!-- The one branch point between the spaces:
           Code hosts the coding agent surface; Roleplay the character surface;
           Home keeps the general chat panel. -->
      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {#if inBots}
          <BotsScreen />
        {:else if inCodeSpace}
          <CodeSurface />
        {:else if appStore.homeView === 'artifacts'}
          <ArtifactsScreen />
        {:else if inRoleplaySpace}
          <RoleplaySurface />
        {:else}
          <HomeSurface />
        {/if}
      </div>
      <RightDock panels={dockPanels} />
    </div>
  </div>
</div>

{#snippet changesPanel()}
  {#if changesTarget}<ChangesPane chatId={changesTarget.chatId} projectRoot={changesTarget.projectRoot} sessionId={changesTarget.sessionId} />{/if}
{/snippet}
{#snippet planPanel()}
  {#if openPlan}{#key openPlan.plan.body}<PlanPanel chatId={openPlan.chatId} plan={openPlan.plan} />{/key}{/if}
{/snippet}
{#snippet artifactPanel()}<ArtifactPanel />{/snippet}
{#snippet browserPanel()}<BrowserPanel />{/snippet}
{#snippet routinesPanel()}
  {#if botsStore.current}<BotRoutines bot={botsStore.current} onclose={() => (botsStore.routinesOpen = false)} />{/if}
{/snippet}

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
  <div class="ui-modal-backdrop" use:modalLayer={{ onclose: () => (showShortcutsHelp = false) }} onclick={() => (showShortcutsHelp = false)}>
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
            <kbd class="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">{formatShortcut(combo)}</kbd>
          </div>
        {/each}
      </dl>
    </div>
  </div>
{/if}

<style>
  .sidebar-outer {
    width: 0;
    transition: width var(--motion-smooth) var(--motion-ease-out);
  }
  /* Default 15rem: room for a project tree with row actions and status
     dots; dragging the edge sets --sidebar-w. */
  .sidebar-outer.expanded {
    width: var(--sidebar-w, 15rem);
  }

  /* The sidebar's edge, drawn above the panel inside it (whose fixed width
     would otherwise paint over a border), in the same colour as the
     preview's edge. */
  .sidebar-outer.expanded::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 1;
    width: 1px;
    background: var(--border-hover);
    pointer-events: none;
  }
  .sidebar-outer.resizing {
    transition: none;
  }

  .sidebar-view-full {
    width: var(--sidebar-w, 15rem);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    overflow: hidden;
    transition: opacity 150ms ease, visibility 0s linear 150ms;
  }
  .sidebar-outer.expanded .sidebar-view-full,
  .sidebar-view-full.preview {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition-delay: 40ms, 0s;
  }

  /* The preview is the same sidebar floating over the content: full height
     to the top of the window, same colour, with the title bar's left buttons
     redrawn in place (TitlebarLeftTools) and a shadow over the content. */
  .sidebar-view-full.preview {
    position: fixed;
    z-index: var(--z-float);
    top: 0;
    bottom: 0;
    left: 0;
    right: auto;
    max-width: calc(100vw - 1rem);
    background: var(--sidebar);
    border-right: 1px solid var(--border-hover);
    box-shadow: var(--shadow-xl);
  }

  .preview-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar-outer { transition: none; will-change: auto; }
    .sidebar-view-full { transition: none; }
  }
</style>
