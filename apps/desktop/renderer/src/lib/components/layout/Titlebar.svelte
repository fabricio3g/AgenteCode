<svelte:options runes={true} />

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import DownloadsButton from './DownloadsButton.svelte';
  import { onMount } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { ArrowLeft, Globe, MoonStar, Search, SunMedium } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { Button } from '$lib/components/ui';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { browserPanelStore, type BrowserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { untrack } from 'svelte';
  import { workspaceLayout, type WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import { conversationScope } from '$shared/workspace-scope';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { isCodeSession } from '$lib/features/shared/session-guards';
  import PanelTabs from './PanelTabs.svelte';
  import TitlebarLeftTools from './TitlebarLeftTools.svelte';
  import SpaceSwitcher from './SpaceSwitcher.svelte';
  import WindowControls from './WindowControls.svelte';
  import { PanelRight as ContextIcon } from 'lucide-svelte';
  import ComputerButton from '$lib/features/computer/ComputerButton.svelte';
  import NotificationsButton from '$lib/features/shared/NotificationsButton.svelte';

  let { sidebarPreview = false, settingsOpen = false, onSidebarEnter, onSidebarLeave, onSidebarToggle }: {
    sidebarPreview?: boolean;
    /** Settings owns the window, so the bar's own tools stay out of the way. */
    settingsOpen?: boolean;
    onSidebarEnter: () => void;
    onSidebarLeave: (event: PointerEvent) => void;
    onSidebarToggle: () => void;
  } = $props();

  /** The open Code conversation: its tools sit in this bar unless the centre is split. */
  const codeChat = $derived.by(() => {
    const chat = appStore.currentChat;
    return appStore.activeTab === 'code' && chat && isCodeSession(chat) ? chat : null;
  });
  const codeProject = $derived(codeStore.projectById(codeChat?.projectId ?? null));
  const scope = $derived(codeChat ? conversationScope(codeChat.id) : null);
  // The conversation's own stores are created on demand, which writes state: that
  // belongs in an effect, never in a $derived or the template.
  let chatLayout = $state<WorkspaceLayoutStore>(workspaceLayout);
  let chatBrowser = $state<BrowserPanelStore>(browserPanelStore);
  $effect(() => {
    const id = scope;
    untrack(() => {
      chatLayout = id ? workspaceLayout.scoped(id) : workspaceLayout;
      chatBrowser = id ? browserPanelStore.forScope(id) : browserPanelStore;
    });
  });
  // Settings owns the window: a conversation's pane toggles have nothing to act on there.
  const toolsHere = $derived(!settingsOpen && workspaceLayout.panes.length < 2);

  const platform = typeof window !== 'undefined' ? (window.electronAPI?.platform ?? 'linux') : 'linux';
  const isMac = platform === 'darwin';

  onMount(() => {
    void downloadsStore.refresh();
  });
</script>

<!--
  No OS caption buttons anywhere: Windows and Linux draw minimize/maximize/
  close in the page (`WindowControls.svelte`), macOS keeps its traffic lights
  outside the web contents. Nothing here has to reserve space for the platform
  — only macOS needs its traffic-light inset, set in CSS below.
-->

<!-- Spaces sit at the start of the titlebar; pane controls, downloads and theme sit at the end. -->
{#snippet appTools()}
  <div class="flex items-center gap-0.5">
    {#if toolsHere && codeChat}
      <div class="titlebar-no-drag flex items-center">
        <PanelTabs inline chat={codeChat} project={codeProject} layout={chatLayout} browser={chatBrowser} />
      </div>
      <span class="mx-1 h-4 w-px bg-[var(--border)]" aria-hidden="true"></span>
    {/if}
    <!-- Home, Roleplay and Bots have no pane strip, so the browser opens from here.
         Code draws the same globe in its strip, on the conversation's own browser. -->
    {#if !codeChat}
      <Tooltip label={$t('browser.title')} position="bottom">
        <UiIconButton label={$t('browser.title')} size="sm"
          type="button"
          class={uiClass(" titlebar-no-drag", {"selected": browserPanelStore.open})}

          aria-pressed={browserPanelStore.open}

          data-panel-tab="browser"
          onclick={() => void browserPanelStore.toggle().catch((error) => toastStore.error(String(error)))}
        >
          <Globe class="size-4" />
        </UiIconButton>
      </Tooltip>
      {#if !settingsOpen && appStore.activeSpace === 'home' && appStore.homeView === 'chat' && appStore.currentChat}
        <Tooltip label={$t('context.button')} position="bottom">
          <UiIconButton label={$t('context.button')} size="sm" type="button"
            class={uiClass(" titlebar-no-drag", {"selected": workspaceLayout.isOpen('context')})}
            aria-pressed={workspaceLayout.isOpen('context')}
            data-panel-tab="context"
            onclick={() => workspaceLayout.toggle('context')}
          >
            <ContextIcon class="size-4" />
          </UiIconButton>
        </Tooltip>
      {/if}
    {/if}
    {#if !settingsOpen && appStore.currentChat && (appStore.activeSpace === 'home' || appStore.activeSpace === 'code')}
      <ComputerButton />
    {/if}
    <DownloadsButton />
    <NotificationsButton />
    <Tooltip label={$t('titlebar.theme')} position="bottom">
      <UiIconButton label={$t('titlebar.theme')} size="sm"

        onclick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          themeStore.toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }}

      >
        {#if themeStore.current === 'dark'}
          <SunMedium class="size-4" />
        {:else}
          <MoonStar class="size-4" />
        {/if}
      </UiIconButton>
    </Tooltip>
  </div>
{/snippet}
<div
  class="titlebar-row titlebar-drag relative z-20 h-12 shrink-0 select-none bg-background"
  class:is-mac={isMac}
  role="banner"
>
  {#if settingsOpen}
    <!-- Seamless sidebar continuation to topbar -->
    <div
      class="pointer-events-none absolute inset-y-0 left-0 w-[236px] border-r border-[var(--border)] bg-[var(--sheet-rail)]"
      aria-hidden="true"
    ></div>
  {/if}

  <div class="titlebar-safe">
    <div class="titlebar-left flex min-w-0 items-center">
      {#if !settingsOpen}
        {#if !appStore.sidebarOpen}
          <TitlebarLeftTools expanded={appStore.sidebarOpen || sidebarPreview} onToggle={onSidebarToggle} onEnter={onSidebarEnter} onLeave={onSidebarLeave} />
        {/if}
        <SpaceSwitcher />
        <Tooltip label={$t('titlebar.search')} shortcut="mod+shift+k" position="bottom">
          <UiIconButton label={$t('titlebar.search')} title="" size="sm" class="titlebar-no-drag"
            onclick={() => appStore.openSearch()}><Search /></UiIconButton>
        </Tooltip>
      {:else}
        <div class="flex items-center gap-1.5 pl-1.5">
          <Tooltip label={$t('shortcuts.backToConversation')} shortcut="escape">
            <UiIconButton label={$t('shortcuts.backToConversation')} size="sm"
              type="button"
              class={uiClass(" titlebar-no-drag")}
              onclick={() => appStore.closeSettings()}

            >
              <ArrowLeft class="size-4" />
            </UiIconButton>
          </Tooltip>
          <span class="px-1 text-[length:var(--text-sm)] font-semibold text-foreground">{$t('sidebar.settings')}</span>
        </div>
      {/if}
    </div>

    <div class="titlebar-center flex min-w-0 flex-1 items-center"></div>

    <div class="titlebar-right flex items-center justify-end">
      {@render appTools()}
      <WindowControls />
    </div>
  </div>
</div>

<style>
  .titlebar-row {
    position: relative;
    width: 100%;
    container-type: inline-size;
    border-bottom: none;
  }

  /*
   * The bar spans the whole window: the caption is ours on Windows and Linux,
   * so nothing has to be reserved for the platform. The trailing padding only
   * keeps the last mark off the window edge.
   */
  .titlebar-safe {
    /* Above the settings strip (absolute, painted first) so its back button shows. */
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    padding-inline-end: 0.75rem;
    display: grid;
    /* Keep navigation and window actions visible while the drag space shrinks. */
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    overflow: hidden;
  }

  /*
   * macOS keeps its traffic lights, which sit on top of the content outside the
   * web contents: reserve their width at the system inset.
   */
  .titlebar-row.is-mac .titlebar-safe {
    padding-inline-start: 78px;
  }

  .titlebar-center {
    justify-self: center;
    overflow: hidden;
  }

  .titlebar-right {
    justify-self: end;
    overflow: hidden;
  }

  .titlebar-left {
    flex-shrink: 0;
    justify-self: start;
    overflow: hidden;
  }

  @container (max-width: 520px) {
    .titlebar-center { padding-inline: 0.25rem; }
  }
  @container (max-width: 400px) {
    .titlebar-left :global(.titlebar-secondary) { display: none; }
  }
</style>
