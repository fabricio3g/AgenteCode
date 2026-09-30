<svelte:options runes={true} />

<script lang="ts">
  import SidebarInstances from './SidebarInstances.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import CodeSidebar from '$lib/features/code/CodeSidebar.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { smoothEase } from '$lib/utils/transitions';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import { Boxes, Drama, MessageSquare, Plus, Puzzle, Search, Settings } from 'lucide-svelte';
  import { copy } from '$lib/copy';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import BotRoster from '$lib/features/bots/BotRoster.svelte';
  import { botsStore } from '$lib/features/bots/bots.svelte';

  let collapsedGroups = $state<Set<number>>(new Set([4]));

  /** The session list for the active space (home and roleplay share a layout). */
  const listChats = $derived(
    appStore.activeSpace === 'roleplay' ? appStore.visibleRoleplayChats : appStore.visibleHomeChats
  );

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(key: number): string {
    switch (key) {
      case 0: return $t('sidebar.today');
      case 1: return $t('sidebar.yesterday');
      case 2: return $t('sidebar.previous7Days');
      case 3: return $t('sidebar.previous30Days');
      default: return $t('sidebar.older');
    }
  }

  const groupedChats = $derived.by(() => {
    // Home and Roleplay share this date-grouped list; Code uses CodeSidebar.
    type ChatGroup = { key: number; label: string; chats: typeof appStore.visibleHomeChats };
    const groups: ChatGroup[] = [];
    const groupMap = new Map<number, ChatGroup>();

    for (const chat of listChats) {
      const now = startOfDay(Date.now());
      const day = startOfDay(chat.updatedAt || chat.createdAt);
      const diff = Math.floor((now - day) / 86400000);
      const bucket = diff <= 0 ? 0 : diff === 1 ? 1 : diff <= 6 ? 2 : diff <= 29 ? 3 : 4;
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

  const sidebarIconColor = $derived('currentColor');
  const inBots = $derived(appStore.activeTab === 'bots');
  const newButtonLabel = $derived(
    inBots
      ? $t('bots.new')
      : appStore.activeSpace === 'code'
      ? $t('code.addProject')
      : appStore.activeSpace === 'roleplay'
        ? copy.roleplay.newRoleplay
        : $t('sidebar.newChat')
  );

  const searchLabel = $derived(
    appStore.activeSpace === 'code' ? $t('code.searchConversations') : $t('sidebar.searchChats')
  );

  function toggleGroup(key: number) {
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedGroups = next;
  }

  function createForActiveSpace() {
    if (inBots) {
      botsStore.editor = 'new';
      return;
    }
    if (appStore.activeSpace === 'code') {
      void codeStore.addProject();
      return;
    }
    appStore.createChat(appStore.activeSpace);
  }

</script>

<aside class="sidebar relative isolate flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
  <div class="relative z-10 flex min-h-0 flex-1 flex-col px-3 pb-1 pt-2">
    <div class="flex flex-col gap-1.5 pb-3 pt-1">
      <button
        class="new-chat-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1.5 text-sm font-medium transition-colors"
        onclick={createForActiveSpace}
      >
        <Plus class="size-3.5 shrink-0" />
        <span class="btn-label">{newButtonLabel}</span>
      </button>

      <!-- The Code agent does not produce artifacts; the toggle list only
           concerns Home and Roleplay. -->
      {#if appStore.activeSpace !== 'code' && !inBots}
        <button
          class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
          class:is-current={appStore.homeView === 'artifacts'}
          aria-current={appStore.homeView === 'artifacts' ? 'page' : undefined}
          onclick={() => appStore.showArtifactLibrary()}
          title={$t('sidebar.artifacts')}
        >
          <Puzzle class="size-3.5 shrink-0" />
          <span class="btn-label">{$t('sidebar.artifacts')}</span>
        </button>
        <SidebarInstances />
      {/if}
    </div>

    {#if inBots}
      <label class="sidebar-btn bot-filter flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px]">
        <Search class="size-3.5 shrink-0" />
        <input data-bot-search bind:value={botsStore.query} placeholder={$t('bots.search')} aria-label={$t('bots.search')} />
      </label>
    {:else}
    <button
      type="button"
      class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
      onclick={() => { appStore.chatSearchOpen = true; }}
      title={`${searchLabel} (${formatShortcut('mod+shift+k')})`}
    >
      <Search class="size-3.5 shrink-0" />
      <span class="btn-label btn-label-truncate">{searchLabel}</span>
    </button>
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
            <button
              type="button"
              class="group-label w-full cursor-pointer px-2 pb-1 pt-3 text-left text-[11px] font-semibold text-[var(--text-muted)]"
              aria-expanded={!isCollapsed}
              onclick={() => toggleGroup(group.key)}
            >
              {group.label}
            </button>
            {#if !isCollapsed}
            <div class="space-y-0.5" transition:slide={{ duration: 140 }}>
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
        <div class="empty-state flex flex-col items-center justify-center py-12 text-center">
          <div class="empty-icon mb-2 flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]">
            {#if appStore.activeSpace === 'roleplay'}
              <Drama class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
            {:else}
              <MessageSquare class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
            {/if}
          </div>
          {#if appStore.activeSpace === 'roleplay'}
            <p class="text-[14px] text-[var(--text-muted)]">{copy.roleplay.noRoleplays}</p>
            <p class="mt-0.5 text-[12px] text-[var(--text-muted)]">{copy.roleplay.noRoleplaysHint}</p>
          {:else}
            <p class="text-[14px] text-[var(--text-muted)]">{$t('sidebar.noConversations')}</p>
            <p class="mt-0.5 text-[12px] text-[var(--text-muted)]">{$t('sidebar.emptyHint')}</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="sidebar-footer px-0.5 py-2">
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
        onclick={() => { appStore.modelManagerOpenSection = 'models'; appStore.modelManagerOpen = true; }}
        title={$t('sidebar.models')}
      >
        <Boxes class="size-3.5 shrink-0" />
        <span class="btn-label">{$t('sidebar.models')}</span>
      </button>
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
        onclick={() => { appStore.modelManagerOpenSection = 'general'; appStore.modelManagerOpen = true; }}
        title={$t('sidebar.settings')}
      >
        <Settings class="size-3.5 shrink-0" />
        <span class="btn-label">{$t('sidebar.settings')}</span>
      </button>
    </div>
  </div>
</aside>

<style>
  .btn-label-truncate {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .bot-filter input {
    min-width: 0;
    flex: 1;
    background: transparent;
    color: var(--sidebar-foreground);
    outline: none;
  }

  .bot-filter input::placeholder {
    color: inherit;
  }

  .new-chat-btn {
    color: var(--sidebar-foreground);
    background: transparent;
    border: none;
  }

  .new-chat-btn:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .btn-label {
    color: inherit;
  }

  .group-label {
    appearance: none;
    border: 0;
    outline: none;
    box-shadow: none;
    background: transparent;
    font-family: inherit;
  }

  .group-label:hover {
    color: var(--sidebar-foreground);
  }

  /* A quiet raised fill, not an inverted slab. A white pill in a dark sidebar
     pulls more attention than the conversation itself. */
  .empty-icon {
    background: var(--sidebar-accent);
    border: 1px solid var(--sidebar-border);
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
  }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding-top: 0.5rem;
  }

  .sidebar-btn {
    color: var(--text-secondary);
    background: transparent;
    border: none;
  }

  .sidebar-btn:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .sidebar-btn.is-current {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
    font-weight: 500;
  }

</style>
