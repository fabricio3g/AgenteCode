<svelte:options runes={true} />

<script lang="ts">
  import SidebarInstances from './SidebarInstances.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import CodeSidebar from '$lib/features/code/CodeSidebar.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import type { ChatContextMode } from '$lib/types/chat';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { smoothEase } from '$lib/utils/transitions';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import { Bot, Boxes, Code2, Drama, House, MessageSquare, Plus, Puzzle, Search, Settings } from 'lucide-svelte';
  import { copy } from '$lib/copy';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';

  let collapsedGroups = $state<Set<number>>(new Set([4]));

  // Roleplay is opt-in: the tab only exists once the setting is on.
  const spaceTabs = $derived<Array<{ id: ChatContextMode; label: string; icon: typeof House }>>([
    { id: 'home', label: copy.spaces.home, icon: House },
    { id: 'code', label: copy.spaces.code, icon: Code2 },
    ...(appStore.roleplayEnabled
      ? [{ id: 'roleplay' as ChatContextMode, label: copy.spaces.roleplay, icon: Drama }]
      : [])
  ]);

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
  const newButtonLabel = $derived(
    appStore.activeSpace === 'code'
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
    if (appStore.activeSpace === 'code') {
      void codeStore.addProject();
      return;
    }
    appStore.createChat(appStore.activeSpace);
  }

  function onSpaceTabsKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const ids = spaceTabs.map((t) => t.id);
    const current = ids.indexOf(appStore.activeSpace);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % ids.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + ids.length) % ids.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ids.length - 1;
    appStore.setActiveSpace(ids[next]!);
    queueMicrotask(() => {
      document.getElementById(`space-tab-${ids[next]}`)?.focus();
    });
  }

</script>

<aside class="sidebar relative isolate flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
  <div class="relative z-10 flex min-h-0 flex-1 flex-col px-3 pb-1 pt-2">
    <div class="flex flex-col gap-1.5 pb-3 pt-1">
      <div
        class="space-tabs"
        role="tablist"
        tabindex="-1"
        aria-label="Session type"
        onkeydown={onSpaceTabsKeydown}
      >
        {#each spaceTabs as tab (tab.id)}
          {@const Icon = tab.icon}
          <button
            type="button"
            class="space-tab"
            class:active={appStore.activeSpace === tab.id}
            role="tab"
            id={`space-tab-${tab.id}`}
            tabindex={appStore.activeSpace === tab.id ? 0 : -1}
            aria-selected={appStore.activeSpace === tab.id}
            aria-label={tab.label}
            title={tab.label}
            onclick={() => appStore.setActiveSpace(tab.id)}
          >
            <Icon class="space-tab-icon size-4" />
            <!-- The label stays in the DOM and animates open on the selected
                 tab (0fr → 1fr grid); inactive tabs stay icon-only so three
                 spaces fit the rail. aria-label keeps every tab named. -->
            <span class="space-tab-label" aria-hidden="true">
              <span class="space-tab-label-text">{tab.label}</span>
            </span>
          </button>
        {/each}
      </div>
      <button
        class="new-chat-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1.5 text-sm font-medium transition-colors"
        onclick={createForActiveSpace}
      >
        <Plus class="size-4 shrink-0" />
        <span class="btn-label">{newButtonLabel}</span>
      </button>

      <!-- The Code agent does not produce artifacts; the toggle list only
           concerns Home and Roleplay. -->
      {#if appStore.activeSpace !== 'code'}
        <button
          class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
          class:is-current={appStore.homeView === 'artifacts'}
          aria-current={appStore.homeView === 'artifacts' ? 'page' : undefined}
          onclick={() => appStore.showArtifactLibrary()}
          title={$t('sidebar.artifacts')}
        >
          <Puzzle class="size-4 shrink-0" />
          <span class="btn-label">{$t('sidebar.artifacts')}</span>
        </button>
        <button
          class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
          class:is-current={appStore.homeView === 'bots'}
          aria-current={appStore.homeView === 'bots' ? 'page' : undefined}
          onclick={() => appStore.showBots()}
          title={$t('sidebar.bots')}
        >
          <Bot class="size-4 shrink-0" />
          <span class="btn-label">{$t('sidebar.bots')}</span>
        </button>
        <SidebarInstances />
      {/if}
    </div>

    <button
      type="button"
      class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
      onclick={() => { appStore.chatSearchOpen = true; }}
      title={`${searchLabel} (${formatShortcut('mod+shift+k')})`}
    >
      <Search class="size-4 shrink-0" />
      <span class="btn-label btn-label-truncate">{searchLabel}</span>
    </button>

    <div class="chat-list flex-1 overflow-y-auto">
      <!-- Code tab: the sidebar is a project-folder tree; each folder holds
           that project's agent conversations. -->
      {#if appStore.activeSpace === 'code'}
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
        <Boxes class="size-4 shrink-0" />
        <span class="btn-label">{$t('sidebar.models')}</span>
      </button>
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-full px-2.5 py-1 text-[13px] transition-colors"
        onclick={() => { appStore.modelManagerOpenSection = 'general'; appStore.modelManagerOpen = true; }}
        title={$t('sidebar.settings')}
      >
        <Settings class="size-4 shrink-0" />
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

  .new-chat-btn {
    color: var(--sidebar-foreground);
    background: transparent;
    border: none;
  }

  .space-tabs {
    display: flex;
    gap: 2px;
    border-radius: var(--radius-full);
    background: var(--muted);
    border: 0;
    padding: 3px;
  }

  .space-tab {
    min-width: 0;
    /* Icon-only tabs size to their icon; the selected tab takes the rest and
       reveals its label. */
    flex: 0 0 auto;
    height: 1.875rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition:
      flex-grow var(--motion-smooth) var(--motion-ease-out),
      padding-inline var(--motion-smooth) var(--motion-ease-out),
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease),
      box-shadow var(--motion-fast) var(--motion-ease);
  }

  .space-tab :global(.space-tab-icon) {
    flex-shrink: 0;
  }

  /* Icon-only tabs get a square-ish hit area around the glyph instead of
     hugging it, so they are comfortable to click without a label. */
  .space-tab:not(.active) {
    min-width: 1.875rem;
    padding-inline: 0.375rem;
  }

  /* Grid 0fr → 1fr is the one width animation that eases smoothly without
     measuring text; the inner span owns the clipping. */
  .space-tab-label {
    display: grid;
    grid-template-columns: 0fr;
    opacity: 0;
    transition:
      grid-template-columns var(--motion-smooth) var(--motion-ease-out),
      opacity var(--motion-fast) var(--motion-ease);
  }

  .space-tab.active .space-tab-label {
    grid-template-columns: 1fr;
    opacity: 1;
  }

  .space-tab-label-text {
    overflow: hidden;
    white-space: nowrap;
  }

  .space-tab:hover:not(.active) {
    color: var(--sidebar-foreground);
    background: color-mix(in srgb, var(--sidebar-foreground) 6%, transparent);
  }

  /* Raised pill on the track — same treatment as .aui-segmented-item.is-active,
     so tabs read the same wherever they appear. */
  .space-tab.active {
    /* Animate flex-grow, not flex-basis: grow is interpolatable in Chromium. */
    flex-grow: 1;
    padding-inline: 0.625rem;
    background: var(--surface-active);
    color: var(--foreground);
  }

  .space-tab:focus-visible {
    outline: 2px solid var(--sidebar-ring);
    outline-offset: 1px;
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
    color: var(--muted-foreground);
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

  @media (prefers-reduced-motion: reduce) {
    .space-tab,
    .space-tab-label {
      transition: none;
    }
  }
</style>
