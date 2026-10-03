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
  import { Drama, MessageSquare, Plus, Puzzle, Search, Settings } from 'lucide-svelte';
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
    // Read once: the same midnight is the reference for every row below.
    const now = startOfDay(Date.now());

    for (const chat of listChats) {
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
        class="sidebar-row is-emphasis"
        onclick={createForActiveSpace}
      >
        <Plus class="size-3.5 shrink-0" />
        <span class="sidebar-row-label">{newButtonLabel}</span>
      </button>

      <!-- The Code agent does not produce artifacts; the toggle list only
           concerns Home and Roleplay. -->
      {#if appStore.activeSpace !== 'code' && !inBots}
        <button
          class="sidebar-row"
          class:is-current={appStore.homeView === 'artifacts'}
          aria-current={appStore.homeView === 'artifacts' ? 'page' : undefined}
          onclick={() => appStore.showArtifactLibrary()}
          title={$t('sidebar.artifacts')}
        >
          <Puzzle class="size-3.5 shrink-0" />
          <span class="sidebar-row-label">{$t('sidebar.artifacts')}</span>
        </button>
      {/if}
    </div>

    {#if inBots}
      <label class="sidebar-row bot-filter">
        <Search class="size-3.5 shrink-0" />
        <input data-bot-search bind:value={botsStore.query} placeholder={$t('bots.search')} aria-label={$t('bots.search')} />
      </label>
    {:else}
    <button
      type="button"
      class="sidebar-row"
      onclick={() => { appStore.chatSearchOpen = true; }}
      title={`${searchLabel} (${formatShortcut('mod+shift+k')})`}
    >
      <Search class="size-3.5 shrink-0" />
      <span class="sidebar-row-label">{searchLabel}</span>
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
              class="sidebar-section"
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
        <div class="sidebar-empty">
          <div class="sidebar-empty-icon">
            {#if appStore.activeSpace === 'roleplay'}
              <Drama class="h-4 w-4" />
            {:else}
              <MessageSquare class="h-4 w-4" />
            {/if}
          </div>
          {#if appStore.activeSpace === 'roleplay'}
            <p>{copy.roleplay.noRoleplays}</p>
            <p class="sidebar-empty-hint">{copy.roleplay.noRoleplaysHint}</p>
          {:else}
            <p>{$t('sidebar.noConversations')}</p>
            <p class="sidebar-empty-hint">{$t('sidebar.emptyHint')}</p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- One way in: Models, providers and preferences are all sections of
         the Settings screen, so a second sidebar entry would be a second
         door to the same room.

         The running-model list sits here rather than above the search field:
         a model loading must not push the search field and every conversation
         below it down the rail. -->
    <div class="sidebar-footer">
      <SidebarInstances />
      <button
        data-sidebar-settings
        class="sidebar-row"
        onclick={() => appStore.openSettings('general')}
        title={$t('sidebar.settings')}
        class:is-current={appStore.settingsScreenOpen}
      >
        <Settings class="size-3.5 shrink-0" />
        <span class="sidebar-row-label">{$t('sidebar.settings')}</span>
      </button>
    </div>
  </div>
</aside>

<style>
  .bot-filter input {
    min-width: 0;
    flex: 1;
    background: transparent;
    color: inherit;
    outline: none;
  }

  .bot-filter input::placeholder {
    color: inherit;
  }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding-top: 0.5rem;
  }
</style>
