<svelte:options runes={true} />

<script lang="ts">
  import FolderBrowserDialog from '$lib/features/code/FolderBrowserDialog.svelte';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { onMount, untrack } from 'svelte';
  import { motionFade } from '$lib/utils/transitions';
  import { conversationScope } from '$shared/workspace-scope';
  import { t } from 'svelte-i18n';
  import Titlebar from '$lib/components/layout/Titlebar.svelte';
  import ActivityRail from '$lib/components/layout/ActivityRail.svelte';
  import Sidebar from '$lib/components/layout/Sidebar.svelte';
  import HomeSurface from '$lib/features/home/HomeSurface.svelte';
  import ConversationPanes from '$lib/features/code/ConversationPanes.svelte';
  import ArtifactsScreen from '$lib/features/artifacts/ArtifactsScreen.svelte';
  import FilesScreen from '$lib/features/files/FilesScreen.svelte';
  import BotsScreen from '$lib/features/bots/BotsScreen.svelte';
  import BotRoutines from '$lib/features/bots/BotRoutines.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';
  import ArtifactPanel from '$lib/features/artifacts/ArtifactPanel.svelte';
  import RoleplaySurface from '$lib/features/roleplay/RoleplaySurface.svelte';
  import DesignSurface from '$lib/features/design/DesignSurface.svelte';
  import { charactersStore } from '$lib/features/roleplay/characters.svelte';
  import { worldsStore } from '$lib/features/roleplay/worlds.svelte';
  import { ensureStarterKit, starterKitStore } from '$lib/features/roleplay/starter-kit';
  import { codeStore } from '$lib/features/code/code.svelte';
  import SystemPromptModal from '$lib/components/settings/SystemPromptModal.svelte';
  import LocalModelLoadModal from '$lib/components/settings/LocalModelLoadModal.svelte';
  import SettingsScreen from '$lib/components/settings/SettingsScreen.svelte';
  import { openModalLayerCount } from '$lib/components/ui/modal-layer';
  import ArtifactStudioModal from '$lib/components/agent/ArtifactStudioModal.svelte';
  import DomainWorkspace from '$lib/features/domains/DomainWorkspace.svelte';
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
  import WorkspaceHost from './WorkspaceHost.svelte';
  import type { WorkspacePanel, PanelRenderState } from './workspace-panel';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { FileBox, Globe, Image, ListTodo } from 'lucide-svelte';
  import CanvasPanel from '$lib/features/canvas/CanvasPanel.svelte';
  import TitlebarLeftTools from './TitlebarLeftTools.svelte';
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
  let artifactPanelHandle = $state<{ requestClose: () => void }>();
  // The top-bar tab decides the main view; Bots sits beside the three spaces.
  const inBots = $derived(appStore.activeTab === 'bots');
  const inCodeSpace = $derived(appStore.activeTab === 'code');

  const scope = $derived(inBots && botsStore.current ? conversationScope(`bot:${botsStore.current.handle}`) : !inBots && appStore.currentChat ? conversationScope(appStore.currentChat.id) : inCodeSpace ? `space:code:${codeStore.activeProjectId ?? 'none'}` : `space:${appStore.activeTab}`);
  /*
   * The centre's home. Panes span conversations — two panes can be two chats —
   * so they cannot live in a chat-scoped layout; the space owns them, and the
   * dock below still belongs to the conversation being read.
   */
  const windowId = new URLSearchParams(window.location.search).get('window');
  const spaceKey = $derived(inBots ? `space:bots:${botsStore.current?.handle ?? 'none'}` : inCodeSpace ? `space:code${windowId ? ':' + windowId : ''}` : `space:${appStore.activeTab}`);
  $effect.pre(() => {
    const owner = scope;
    const space = spaceKey;
    untrack(() => { workspaceLayout.spaceScope = space;
      if (inCodeSpace && !windowId && !workspaceLayout.centre) {
        const old = workspaceLayout.layouts[`space:code:${codeStore.activeProjectId ?? 'none'}`]?.centre;
        if (old) workspaceLayout.centre = old;
      }
      workspaceLayout.selectScope(owner); if (!inCodeSpace) void browserPanelStore.selectScope(owner); });
  });

  // The right dock: Changes and the presented plan (Code), the open artifact
  // (Home chat) and the agent browser, stacked when more than one is open.
  const changesTarget = $derived(codeWorkspace.changesTarget);
  const showArtifact = $derived(!inCodeSpace && !inBots && appStore.homeView === 'chat' && !!appStore.artifactPanel);
  const showRoutines = $derived(inBots && !!botsStore.current && botsStore.routinesOpen);
  /** The canvas annotates for whichever conversation is open, so it follows the chat. */
  const canvasAvailable = $derived((inCodeSpace && !!changesTarget) || (!inCodeSpace && !inBots && appStore.homeView === 'chat' && !!appStore.currentChat));
  const dockPanels = $derived.by(() => {
    const panels: WorkspacePanel[] = [
      { id: 'artifact', title: $t('artifacts.title'), icon: FileBox, content: artifactPanel, region: 'right', available: showArtifact, open: showArtifact, onhide: () => artifactPanelHandle?.requestClose() },
      { id: 'routines', title: $t('bots.routines'), icon: ListTodo, content: routinesPanel, region: 'right', available: showRoutines, open: showRoutines, onhide: () => (botsStore.routinesOpen = false) },
      { id: 'browser', title: $t('browser.title'), icon: Globe, content: browserPanel, region: 'right', available: true, open: browserPanelStore.open, onhide: () => void browserPanelStore.hide() },
      { id: 'canvas', title: $t('canvas.title'), icon: Image, content: canvasPanel, region: 'right', available: canvasAvailable, open: workspaceLayout.isOpen('canvas'), onhide: () => workspaceLayout.hide('canvas') }

    ];
    return panels;
  });
  const inRoleplaySpace = $derived(appStore.activeTab === 'roleplay');
  const inDesignSpace = $derived(appStore.activeTab === 'design');
  /** The screen to leave: Settings is open, or nothing is. */
  const settingsShowing = $derived(appStore.settingsScreenOpen);
  /** Ctrl/⌘+K means "new" in every space — a chat, a roleplay, or a project. */
  const shortcutRows = $derived<Array<[string, string]>>([
    ['mod+k', inBots ? $t('bots.new') : inCodeSpace ? $t('shortcuts.addProject') : inRoleplaySpace ? copy.roleplay.newRoleplay : inDesignSpace ? copy.design.newDesign : $t('shortcuts.newChat')],
    ['mod+shift+k', $t('shortcuts.search')],
    ['mod+,', $t('shortcuts.settings')],
    ['mod+b', $t('shortcuts.sidebar')],
    ...(inCodeSpace ? [] : ([['mod+`', $t('shortcuts.artifactStudio')]] as Array<[string, string]>)),
    ['mod+e', $t('shortcuts.export')],
    ['F2', $t('shortcuts.rename')],
    ['mod+?', $t('shortcuts.help')],
    // Settings is a screen, so Escape leaves it for the conversation.
    ...(settingsShowing ? ([['escape', $t('shortcuts.backToConversation')]] as Array<[string, string]>) : []),
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
    if (appStore.activeSpace === 'roleplay') {
      appStore.openRoleplayLibrary();
      return;
    }
    appStore.createChat(appStore.activeSpace);
  }


  /** A section deep-links the screen; none reopens it where you left off. */
  function openSettings(section: string | null = null) {
    appStore.openSettings(section ? resolveModelHubSection(section) : null);
  }

  function closeSettings() {
    appStore.closeSettings();
    // The sidebar is hidden while Settings is up, so the way back is the space
    // tab: whatever surface returns to already knows where to put the caret.
    const tab = appStore.activeTab === 'bots' ? 'home' : appStore.activeTab;
    requestAnimationFrame(() => document.getElementById(`space-tab-${tab}`)?.focus());
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
      event.preventDefault();
      // A toggle, not a jump: pressed inside Settings it closes it, and it
      // reopens on the section you last used rather than always General.
      if (settingsShowing) closeSettings(); else openSettings();
      return;
    }
    if (event.key === 'Escape' && settingsShowing) {
      // A dialog or menu above the screen owns Escape (modal layers listen on
      // window, we listen on document, so they would never see it).
      if (openModalLayerCount() > 0) return;
      event.preventDefault();
      closeSettings();
      return;
    }
    if (ctrl && event.key === 'b') {
      event.preventDefault();
      // There is no sidebar to show while Settings owns the window.
      if (!settingsShowing) toggleSidebar();
      return;
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
    openSettings(legacyFlagToModelHubSection('settingsOpen'));
  });

  $effect(() => {
    if (!appStore.runtimeManagerOpen) return;
    appStore.runtimeManagerOpen = false;
    openSettings(legacyFlagToModelHubSection('runtimeManagerOpen'));
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
  // The preview helper is a plain object, so the element binding below lands
  // on local state first — binding straight to `peek.panel` warns as a
  // non-reactive target — and an effect hands it over.
  let sidebarPanel = $state<HTMLElement | undefined>(undefined);
  $effect(() => {
    peek.panel = sidebarPanel;
  });

  function toggleSidebar() {
    peek.toggled();
    appStore.sidebarOpen = !appStore.sidebarOpen;
  }

  $effect(() => {
    // Settings hides the sidebar; a preview floating over it would be a ghost.
    if (appStore.sidebarOpen || settingsShowing) peek.close();
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
  <!-- The activity rail is always on: spaces, Settings, downloads and theme
       stay one click away even while Settings owns the content area. Only the
       collapsible sidebar hides. -->
  <ActivityRail />
  <!-- Full-height sidebar (Flaxeo pattern): rail | sidebar | titlebar+main.
       Settings hides the sidebar, never the rail. -->
  {#if !settingsShowing}
    <div
      class="sidebar-outer relative flex shrink-0 flex-col bg-sidebar"
      class:expanded={appStore.sidebarOpen}
      class:resizing={sidebarResizing}
      style="--sidebar-w: {sidebarWidth}px"
    >
      <div
        bind:this={sidebarPanel}
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
        <Sidebar onNavigate={() => peek.toggled()} />
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
  {/if}

  <!-- No overflow-hidden on this column: titlebar fade hangs below h-9. -->
  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <Titlebar
      sidebarPreview={peek.open}
      settingsOpen={settingsShowing}
      onSidebarEnter={() => peek.show()}
      onSidebarLeave={(event) => peek.leave(event)}
      onSidebarToggle={toggleSidebar}
    />

    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {#if inCodeSpace}
        <ConversationPanes />
      {:else}
      <WorkspaceHost panels={dockPanels}>
        <!-- The one branch point between the spaces:
             Code hosts the coding agent surface; Roleplay the character surface;
             Home keeps the general chat panel. -->
        <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {#if inBots}
            <BotsScreen />
          {:else if appStore.homeView === 'artifacts'}
            <ArtifactsScreen />
          {:else if inRoleplaySpace}
            <RoleplaySurface />
          {:else if inDesignSpace}
            <DesignSurface />
          {:else}
            <HomeSurface />
          {/if}
        </div>
      </WorkspaceHost>
      {/if}

      <!-- Files covers whichever space is underneath instead of replacing it, so
           opening it from Code never unmounts a running session or a terminal. -->
      {#if appStore.homeView === 'files' && !inBots && !settingsShowing}
        <div data-overlay="files" class="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col bg-background">
          <FilesScreen />
        </div>
      {/if}

      <!-- Settings sits over the workspace rather than in the branch above it:
           the surface underneath stays mounted, so a trip to Settings costs no
           scroll position and no streaming turn, and leaving lands you exactly
           where you were. It covers the title bar too — the screen's nav column
           runs to the top edge of the window, and the page header carries the
           drag region the bar gave up. Above the dock panels (z-index 1..n) and
           above the bar itself on purpose. -->
      {#if settingsShowing}
        <div
          data-overlay="settings"
          class="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-background"
          transition:motionFade={{ duration: isElectron() ? 0 : 160 }}
        >
          <SettingsScreen />
        </div>
      {/if}
    </div>
  </div>
</div>

{#snippet artifactPanel(state: PanelRenderState)}<ArtifactPanel embedded exposed={state.exposed} bind:this={artifactPanelHandle} />{/snippet}
{#snippet browserPanel(state: PanelRenderState)}<BrowserPanel embedded exposed={state.exposed && !settingsShowing} presentationKey={JSON.stringify(state.rect)} chatId={inBots ? undefined : appStore.currentChat?.id} />{/snippet}
{#snippet routinesPanel()}
  {#if botsStore.current}<BotRoutines embedded bot={botsStore.current} onclose={() => (botsStore.routinesOpen = false)} />{/if}
{/snippet}
{#snippet canvasPanel()}
  {#if appStore.currentChat}<CanvasPanel chatId={appStore.currentChat.id} />{/if}
{/snippet}

{#if appStore.promptConfigOpen}
  <SystemPromptModal />
{/if}
<LocalModelLoadModal />


<Toaster />
<ConfirmDialog />
<LLMDrawer />

{#if appStore.artifactStudioOpen && appStore.currentArtifact}
  <ArtifactStudioModal />
  <DomainWorkspace />
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
      class="ui-modal-surface max-w-sm p-6"
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


<FolderBrowserDialog />

<style>
  .sidebar-outer {
    width: 0;
    transition: none;
  }
  /* Default 15rem: room for a project tree with row actions and status
     dots; dragging the edge sets --sidebar-w. */
  .sidebar-outer.expanded {
    width: var(--sidebar-w, 15rem);
  }

  /* The sidebar's edge, drawn above the panel inside it (whose fixed width
     would otherwise paint over a border). A step quieter than the preview's:
     the inset inside the rail already darkens this boundary, so a hard line
     here would read as a doubled edge. */
  .sidebar-outer.expanded::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 1;
    width: 1px;
    background: var(--border);
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
    transition: none;
  }
  .sidebar-outer.expanded .sidebar-view-full,
  .sidebar-view-full.preview {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
  }

  /* The preview is the same sidebar floating over the content: full height
     to the top of the window, starting beside the always-on activity rail
     (--rail-w) so it never covers it, with the title bar's left buttons redrawn
     in place (TitlebarLeftTools). It reads as a panel, not as the docked rail:
     the same surface, but the outer corners round like the workspace cards, the
     seam steps up to --border-hover and the elevation comes from --shadow-xl. */
  .sidebar-view-full.preview {
    position: fixed;
    z-index: var(--z-float);
    top: 0;
    bottom: 0;
    left: var(--rail-w);
    right: auto;
    max-width: calc(100vw - 1rem);
    background: var(--sidebar);
    border-right: 1px solid var(--border-hover);
    border-radius: 0 0.875rem 0.875rem 0;
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
