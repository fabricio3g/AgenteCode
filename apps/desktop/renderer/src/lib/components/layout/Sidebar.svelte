<svelte:options runes={true} />

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  let { onNavigate, onToggle }: { onNavigate?: () => void; onToggle?: () => void } = $props();
  import { PanelLeftClose, Search as SearchIcon } from 'lucide-svelte';
  import SidebarInstances from './SidebarInstances.svelte';
  import SpaceSwitcher from './SpaceSwitcher.svelte';
  import CalendarPreview from '$lib/features/home/CalendarPreview.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import CodeSidebar from '$lib/features/code/CodeSidebar.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { smoothEase } from '$lib/utils/transitions';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import { Settings as SettingsIcon, Blocks, CalendarDays, ChevronsDownUp, ChevronsUpDown, Drama, FolderOpen, MessageSquare, MoreHorizontal, PenTool, Plus, Puzzle, Trash2 } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';

  let collapsedGroups = $state<Set<number>>(new Set([4]));

  /** The session list for the active space (home and roleplay share a layout). */
  const listChats = $derived(
    appStore.activeSpace === 'roleplay' ? appStore.visibleRoleplayChats
      : appStore.activeSpace === 'design' ? appStore.visibleDesignChats
        : appStore.visibleHomeChats
  );

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Conversations started in the browser extension's chat panel. */
  const BROWSER_GROUP = -1;

  function groupLabel(key: number): string {
    switch (key) {
      case BROWSER_GROUP: return $t('sidebar.browser');
      case 0: return $t('sidebar.today');
      case 1: return $t('sidebar.yesterday');
      case 2: return $t('sidebar.previous7Days');
      case 3: return $t('sidebar.previous30Days');
      default: return $t('sidebar.older');
    }
  }

  const groupedChats = $derived.by(() => {
    // Home, Roleplay and Design share this date-grouped list; Code uses CodeSidebar.
    // Browser conversations get their own group, above the dates.
    type ChatGroup = { key: number; label: string; chats: typeof appStore.visibleHomeChats };
    const groups: ChatGroup[] = [];
    const groupMap = new Map<number, ChatGroup>();
    // Read once: the same midnight is the reference for every row below.
    const now = startOfDay(Date.now());

    for (const chat of listChats) {
      const day = startOfDay(chat.updatedAt || chat.createdAt);
      const diff = Math.floor((now - day) / 86400000);
      const bucket = chat.origin === 'browser' ? BROWSER_GROUP : diff <= 0 ? 0 : diff === 1 ? 1 : diff <= 6 ? 2 : diff <= 29 ? 3 : 4;
      if (!groupMap.has(bucket)) {
        groupMap.set(bucket, { key: bucket, label: groupLabel(bucket), chats: [] });
      }
      groupMap.get(bucket)!.chats.push(chat);
    }

    for (const key of Array.from(groupMap.keys()).sort((a, b) => a - b)) {
      const entry = groupMap.get(key)!;
      if (entry.chats.length) groups.push(entry);
    }
    return groups;
  });

  const newButtonLabel = $derived(
    appStore.activeSpace === 'code'
      ? $t('code.addProject')
      : appStore.activeSpace === 'roleplay'
        ? copy.roleplay.newRoleplay
        : appStore.activeSpace === 'design'
          ? copy.design.newDesign
          : $t('sidebar.newChat')
  );

  let listMenuOpen = $state(false);
  const allCollapsed = $derived(groupedChats.length > 0 && groupedChats.every((group) => collapsedGroups.has(group.key)));
  function setAllGroups(collapsed: boolean) {
    collapsedGroups = collapsed ? new Set(groupedChats.map((group) => group.key)) : new Set();
  }

  async function clearHistory() {
    const accepted = await confirmStore.ask({
      title: $t('sidebar.clearHistoryTitle'),
      message: $t('sidebar.clearHistoryMessage'),
      confirmLabel: $t('sidebar.clearHistoryConfirm'),
      danger: true
    });
    if (!accepted) return;
    if (appStore.clearChatHistory()) toastStore.info($t('sidebar.clearHistoryDone'), 2500);
  }

  function toggleGroup(key: number) {
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedGroups = next;
  }

  function createForActiveSpace() {
    onNavigate?.();
    if (appStore.activeSpace === 'code') {
      void codeStore.addProject();
      return;
    }
    if (appStore.activeSpace === 'roleplay') {
      appStore.startRoleplayScene();
      return;
    }
    appStore.createChat(appStore.activeSpace);
  }

</script>

<aside class="sidebar relative isolate flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
  <!-- The spaces head the column they switch. With the column closed they
       move to the titlebar, and a peek at it (which floats under the
       titlebar) draws no head at all: it would be an empty band. -->
  {#if appStore.sidebarOpen}
  <div class="sidebar-head" class:is-mac={typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin'}>
    <SpaceSwitcher />
    {#if onToggle}
      <UiIconButton label={$t('titlebar.hideSidebar')}
        size="sm" data-sidebar-toggle aria-controls="app-sidebar" aria-expanded="true"
        onclick={onToggle}>
        <PanelLeftClose />
      </UiIconButton>
    {/if}
  </div>
  {/if}
  <div class="relative z-10 flex min-h-0 flex-1 flex-col px-2 pb-1">
    <div class="flex flex-col gap-0.5 pb-2 pt-1">
      <UiListRow
        type="button"
        class={uiClass("sidebar-row is-emphasis", "ui-local-0456fb2e")}
        onclick={createForActiveSpace}
      >
        <Plus class="sidebar-row-icon" />
        <span class="sidebar-row-label">{newButtonLabel}</span>
      </UiListRow>

      <UiListRow
        type="button"
        class={uiClass("sidebar-row", "ui-local-0456fb2e")}
        title={`${$t('titlebar.search')} (${formatShortcut('mod+shift+k')})`}
        onclick={() => appStore.openSearch()}
      >
        <SearchIcon class="sidebar-row-icon" />
        <span class="sidebar-row-label">{$t('titlebar.search')}</span>
      </UiListRow>
    </div>

    <div class="chat-list sidebar-scroll flex-1 overflow-y-auto">
      <!-- Code tab: the sidebar is a project-folder tree; each folder holds
           that project's agent conversations. -->
      {#if appStore.activeSpace === 'code'}
        <CodeSidebar />
      {:else if groupedChats.length}
        {#each groupedChats as group, order (group.key)}
          {@const isCollapsed = collapsedGroups.has(group.key)}
          <div class="mb-1.5">
            <div class="sidebar-section-row">
              <UiButton variant="plain"
                type="button"
                class={uiClass("sidebar-section", "ui-local-0456fb2e")}
                aria-expanded={!isCollapsed}
                onclick={() => toggleGroup(group.key)}
              >
                {group.label}
                {#if isCollapsed}<span class="pane-count">{group.chats.length}</span>{/if}
              </UiButton>
              {#if order === 0}
                <!-- List options ride the first heading: clearing history is
                     rare and destructive, so it never gets a row of its own. -->
                <Menu bind:open={listMenuOpen} placement="bottom-end" minWidth="12rem" label={$t('sidebar.listOptions')}>
                  {#snippet trigger(props)}
                    <UiIconButton label={$t('sidebar.listOptions')} size="xs" type="button" class={uiClass("sidebar-row-action", {"is-open": listMenuOpen})} title={$t('sidebar.listOptions')} {...props}><MoreHorizontal /></UiIconButton>
                  {/snippet}
                  {#if allCollapsed}
                    <MenuItem icon={ChevronsUpDown} label={$t('sidebar.expandAll')} onselect={() => setAllGroups(false)} />
                  {:else}
                    <MenuItem icon={ChevronsDownUp} label={$t('sidebar.collapseAll')} onselect={() => setAllGroups(true)} />
                  {/if}
                  <div class="ui-menu-separator" role="separator"></div>
                  <MenuItem icon={Trash2} danger label={$t('sidebar.clearHistory')} onselect={() => void clearHistory()} />
                </Menu>
              {/if}
            </div>
            {#if !isCollapsed}
            <div class="chat-group-rows space-y-0.5" transition:slide={{ duration: 140 }}>
              {#each group.chats as chat (chat.id)}
                <div animate:flip={{ duration: 220, easing: smoothEase }}>
                  <SessionRow
                    {chat}
                    active={appStore.currentChatId === chat.id}
                    onselect={() => appStore.selectChat(chat.id)}
                    menuLabel={$t('sidebar.chatOptions')}
                  />
                </div>
              {/each}
            </div>
            {/if}
          </div>
        {/each}
      {:else}
        {#if appStore.activeSpace === 'roleplay'}
          <EmptyState size="compact" icon={Drama} title={copy.roleplay.noRoleplays} description={copy.roleplay.noRoleplaysHint} />
        {:else if appStore.activeSpace === 'design'}
          <EmptyState size="compact" icon={PenTool} title={copy.design.noDesigns} description={copy.design.noDesignsHint} />
        {:else}
          <EmptyState size="compact" icon={MessageSquare} title={$t('sidebar.noConversations')} description={$t('sidebar.emptyHint')} />
        {/if}
      {/if}
    </div>

    <!-- The running-model list sits here rather than above the search field:
         a model loading must not push the search field and every conversation
         below it down the column. Settings closes the column, one door. -->
    <!-- Places, not actions: they sit under the list, above Settings. -->
    <div class="sidebar-footer">
      {#if appStore.activeSpace === 'home'}
        <Tooltip label={$t('home.calendar.title')} position="right" class="w-full" delay={250}>
          {#snippet content()}<CalendarPreview />{/snippet}
        <UiListRow
          class={uiClass("sidebar-row", "ui-local-0456fb2e", {"is-current": appStore.homeView === 'calendar'})}
          aria-current={appStore.homeView === 'calendar' ? 'page' : undefined}
          onclick={() => { appStore.showCalendar(); onNavigate?.(); }}
        >
          <CalendarDays class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t('home.calendar.title')}</span>
        </UiListRow>
        </Tooltip>
        <UiListRow
          class={uiClass("sidebar-row", "ui-local-0456fb2e", {"is-current": appStore.homeView === 'complements'})}
          aria-current={appStore.homeView === 'complements' ? 'page' : undefined}
          onclick={() => { appStore.showComplements(); onNavigate?.(); }}
        >
          <Blocks class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t('home.complements.title')}</span>
        </UiListRow>
      {/if}

      <!-- The Code agent does not produce artifacts; the toggle list only
           concerns Home and Roleplay. -->
      {#if appStore.activeSpace !== 'code'}
        <UiListRow
          class={uiClass("sidebar-row", "ui-local-0456fb2e", {"is-current": appStore.homeView === 'artifacts'})}

          aria-current={appStore.homeView === 'artifacts' ? 'page' : undefined}
          onclick={() => appStore.showArtifactLibrary()}
          title={$t('sidebar.artifacts')}
        >
          <Puzzle class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t('sidebar.artifacts')}</span>
        </UiListRow>
      {/if}
      <!-- Files spans every space: Code uploads and the documents its agent writes live here too. -->
        <UiListRow
          class={uiClass("sidebar-row", "ui-local-0456fb2e", {"is-current": appStore.homeView === 'files'})}

          aria-current={appStore.homeView === 'files' ? 'page' : undefined}
          onclick={() => appStore.showFileLibrary()}
          title={$t('sidebar.files')}
        >
          <FolderOpen class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t('sidebar.files')}</span>
        </UiListRow>
      <SidebarInstances />
      <UiListRow
        type="button"
        class={uiClass("sidebar-row", "ui-local-0456fb2e")}
        data-sidebar-settings
        onclick={() => { onNavigate?.(); appStore.openSettings('general'); }}
        title={`${$t('sidebar.settings')} (${formatShortcut('mod+,')})`}
      >
        <SettingsIcon class="sidebar-row-icon" />
        <span class="sidebar-row-label">{$t('sidebar.settings')}</span>
      </UiListRow>
    </div>
  </div>
</aside>

<style>
  .sidebar-head { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 0.5rem; height: 3rem; padding: 0 0.5rem; -webkit-app-region: drag; }
  .sidebar-head :global(button) { -webkit-app-region: no-drag; }
  .sidebar-head :global(.space-group) { padding-inline: 0; }
  .sidebar-head.is-mac { padding-inline-start: 78px; }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    /* The utilities under the list are a different kind of row: one hairline says so. */
    border-top: 1px solid var(--border-subtle);
  }
</style>
