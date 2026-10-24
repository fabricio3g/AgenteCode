<svelte:options runes={true} />

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  let { onNavigate, lead }: { onNavigate?: () => void; lead?: Snippet } = $props();
  import type { Snippet } from 'svelte';
  import SpaceSwitcher from './SpaceSwitcher.svelte';
  import SidebarInstances from './SidebarInstances.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import CodeSidebar from '$lib/features/code/CodeSidebar.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { smoothEase } from '$lib/utils/transitions';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import { Settings as SettingsIcon, ChevronsDownUp, ChevronsUpDown, Drama, FolderOpen, MessageSquare, MoreHorizontal, PenTool, Plus, Puzzle, Search, Trash2 } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import BotRoster from '$lib/features/bots/BotRoster.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';

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

  const inBots = $derived(appStore.activeTab === 'bots');
  const newButtonLabel = $derived(
    inBots
      ? $t('bots.new')
      : appStore.activeSpace === 'code'
      ? $t('code.addProject')
      : appStore.activeSpace === 'roleplay'
        ? copy.roleplay.newRoleplay
        : appStore.activeSpace === 'design'
          ? copy.design.newDesign
          : $t('sidebar.newChat')
  );

  const searchLabel = $derived(
    appStore.activeSpace === 'code' ? $t('code.searchConversations') : $t('sidebar.searchChats')
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
    if (inBots) {
      botsStore.editor = 'new';
      return;
    }
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
  <SpaceSwitcher {lead} {onNavigate} />
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

      <!-- The Code agent does not produce artifacts; the toggle list only
           concerns Home and Roleplay. -->
      {#if appStore.activeSpace !== 'code' && !inBots}
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
      {#if !inBots}
        <UiListRow
          class={uiClass("sidebar-row", "ui-local-0456fb2e", {"is-current": appStore.homeView === 'files'})}

          aria-current={appStore.homeView === 'files' ? 'page' : undefined}
          onclick={() => appStore.showFileLibrary()}
          title={$t('sidebar.files')}
        >
          <FolderOpen class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t('sidebar.files')}</span>
        </UiListRow>
      {/if}
    </div>

    {#if inBots}
      <!-- Filters the roster in place, but wears the same row as every other
           space's search so the sidebar reads the same everywhere. -->
      <label class="sidebar-row bot-filter">
        <Search class="sidebar-row-icon" />
        <UiInput variant="inline" class={uiClass('h-auto px-0', "ui-local-0456fb2e")} data-bot-search bind:value={botsStore.query} placeholder={$t('bots.search')} aria-label={$t('bots.search')} />
      </label>
    {:else}
    <div class="search-line">
      <UiListRow
        type="button"
        class={uiClass("sidebar-row min-w-0 flex-1", "ui-local-0456fb2e")}
        onclick={() => { appStore.chatSearchOpen = true; }}
        title={`${searchLabel} (${formatShortcut('mod+shift+k')})`}
      >
        <Search class="sidebar-row-icon" />
        <span class="sidebar-row-label">{searchLabel}</span>
      </UiListRow>
      {#if appStore.activeSpace !== 'code' && groupedChats.length}
        <!-- List options stay behind one small button: clearing history is
             rare and destructive, so it never gets a row of its own. -->
        <Menu bind:open={listMenuOpen} placement="bottom-end" minWidth="12rem" label={$t('sidebar.listOptions')}>
          {#snippet trigger(props)}
            <UiIconButton label={$t('sidebar.listOptions')} size="xs" type="button" class={uiClass("list-options  ", "ui-local-0456fb2e", {"is-open": listMenuOpen})}   title={$t('sidebar.listOptions')} {...props}><MoreHorizontal /></UiIconButton>
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
    {/if}

    <div class="chat-list flex-1 overflow-y-auto">
      <!-- Code tab: the sidebar is a project-folder tree; each folder holds
           that project's agent conversations. -->
      {#if inBots}
        <BotRoster />
      {:else if appStore.activeSpace === 'code'}
        <CodeSidebar />
      {:else if groupedChats.length}
        {#each groupedChats as group (group.key)}
          {@const isCollapsed = collapsedGroups.has(group.key)}
          <div class="mb-1.5">
            <UiButton variant="plain"
              type="button"
              class={uiClass("sidebar-section", "ui-local-0456fb2e")}
              aria-expanded={!isCollapsed}
              onclick={() => toggleGroup(group.key)}
            >
              {group.label}
            </UiButton>
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
    <div class="sidebar-footer">
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
  /* Chats sit one step in from their date, so the list reads as groups. */
  .chat-group-rows { padding-inline-start: 0.25rem; }

  .search-line { display: flex; align-items: center; gap: 0.25rem; }
  /* A bare glyph until hovered or open, so the row stays quiet. */
  :global(.list-options.ui-local-0456fb2e) { flex-shrink: 0; border-color: transparent; background: transparent; box-shadow: none; opacity: 0.7; }
  :global(.list-options:hover.ui-local-0456fb2e), :global(.list-options.is-open.ui-local-0456fb2e) { opacity: 1; background: var(--float-row-hover); }

  .bot-filter :global(input.ui-local-0456fb2e) {
    min-width: 0;
    flex: 1;
    background: transparent;
    color: inherit;
    outline: none;
  }

  .bot-filter :global(input.ui-local-0456fb2e::placeholder) {
    color: inherit;
  }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding-top: 0.5rem;
  }
</style>
