<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import type { ChatContextMode } from '$lib/types/chat';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { Boxes, FileDown, MessageSquare, MoreHorizontal, Pencil, Plus, Puzzle, Search, Settings, Trash2, X } from 'lucide-svelte';

  let search = $state('');
  let searchFocused = $state(false);
  let debouncedSearch = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let renamingChatId = $state<string | null>(null);
  let renamingChatTitle = $state('');
  let renameValue = $state('');
  let openMenuChatId = $state<string | null>(null);
  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);
  let collapsedGroups = $state<Set<number>>(new Set([3]));

  const spaceTabs: Array<{ id: ChatContextMode; label: string; icon: typeof MessageSquare }> = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'work', label: 'Work', icon: Boxes }
  ];
  const brandRibs = Array.from({ length: 20 }, (_, index) => index + 1);

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(ts: number): string {
    const now = startOfDay(Date.now());
    const day = startOfDay(ts);
    const diff = Math.floor((now - day) / 86400000);
    if (diff === 0) return 'Recent';
    if (diff === 1) return $t('sidebar.yesterday') || 'Yesterday';
    if (diff <= 6) return $t('sidebar.thisWeek') || 'This week';
    return $t('sidebar.older') || 'Older';
  }

  const filteredChats = $derived.by(() => {
    const query = debouncedSearch.trim().toLowerCase();
    const chats = appStore.visibleChats;
    if (!query) return chats;
    return chats.filter((chat) => {
      return (
        chat.title.toLowerCase().includes(query) ||
        chat.messages.some((message) => message.content.toLowerCase().includes(query))
      );
    });
  });

  $effect(() => {
    const current = search;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      debouncedSearch = current;
    }, 150);
  });

  const groupedChats = $derived.by(() => {
    // Group into stable buckets to avoid duplicate translated labels
    // (e.g. multiple day-diffs sharing "This week").
    type ChatGroup = { key: number; label: string; chats: (typeof filteredChats)[number][] };
    const groups: ChatGroup[] = [];
    const groupMap = new Map<number, ChatGroup>();

    for (const chat of filteredChats) {
      const now = startOfDay(Date.now());
      const day = startOfDay(chat.updatedAt || chat.createdAt);
      const diff = Math.floor((now - day) / 86400000);
      const bucket = diff <= 0 ? 0 : diff === 1 ? 1 : diff <= 6 ? 2 : 3;
      if (!groupMap.has(bucket)) {
        groupMap.set(bucket, {
          key: bucket,
          label: groupLabel(chat.updatedAt || chat.createdAt),
          chats: []
        });
      }
      groupMap.get(bucket)!.chats.push(chat);
    }

    // Sort groups: Today (0), Yesterday (1), This week (2), Older (3)
    const sortedKeys = Array.from(groupMap.keys()).sort((a, b) => a - b);
    for (const key of sortedKeys) {
      const entry = groupMap.get(key)!;
      if (entry.chats.length) groups.push(entry);
    }
    return groups;
  });

  const isSearching = $derived(search.trim().length > 0);
  const matchCount = $derived(filteredChats.length);
  const sidebarIconColor = $derived('currentColor');
  const newButtonLabel = $derived(appStore.activeSpace === 'work' ? 'New Work' : $t('sidebar.newChat'));

  const activeModel = $derived(
    appStore.backendMode === 'local' ? modelsStore.status?.active_model : null
  );

  function startRename(chatId: string, title: string) {
    renamingChatId = chatId;
    renamingChatTitle = title;
    renameValue = title;
    setTimeout(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    }, 0);
  }

  function closeRename() {
    renamingChatId = null;
    renamingChatTitle = '';
    renameValue = '';
  }

  function commitRename(chatId: string) {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renamingChatTitle) {
      appStore.renameChat(chatId, trimmed);
    }
    closeRename();
  }

  function toggleGroup(key: number) {
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedGroups = next;
  }

  function createForActiveSpace() {
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

  function exportChat(chat: (typeof appStore.chats)[0]) {
    const date = new Date().toISOString().slice(0, 10);
    const lines: string[] = [`# ${chat.title || 'Chat'}\n\n_Exported ${date}_\n`];
    for (const m of chat.messages) {
      if (m.role === 'user') {
        lines.push(`\n---\n\n**You:**\n\n${m.content}`);
      } else {
        const label = m.model ? `**Assistant** (${m.model})` : '**Assistant**';
        lines.push(`\n---\n\n${label}:\n\n${m.content}`);
      }
    }
    const filename = `${(chat.title || 'chat').replace(/[^a-z0-9]+/gi, '_')}_${date}.md`;
    try {
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', filename);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toastStore.success(`Chat exported as ${filename}`, 2500);
    } catch {
      toastStore.error('Export failed — try copying the chat manually.');
    }
  }

  $effect(() => {
    if (!openMenuChatId) return;
    const close = () => {
      openMenuChatId = null;
    };
    const timer = setTimeout(() => {
      document.addEventListener('click', close, { once: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  });
</script>

<aside class="sidebar relative isolate flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
  <div class="sidebar-brand-backdrop" aria-hidden="true">
    <svg class="sidebar-brand-backdrop__texture" viewBox="0 0 208 56" preserveAspectRatio="none">
      <g>
        {#each brandRibs as rib}
          <path d={`M ${rib * 12 - 16} -12 V 72`} class="sidebar-brand-backdrop__rib sidebar-brand-backdrop__rib--shadow" />
          <path d={`M ${rib * 12 - 19} -12 V 72`} class="sidebar-brand-backdrop__rib sidebar-brand-backdrop__rib--light" />
        {/each}
      </g>
    </svg>
  </div>
  <div class="relative z-10 flex min-h-0 flex-1 flex-col px-3 pb-1 pt-3">

    <div class="flex flex-col gap-1.5 pb-3">
      <BrandMark
        size="sm"
        class="sidebar-brand-mark"
      />
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
            onclick={() => appStore.setActiveSpace(tab.id)}
          >
            <Icon class="space-tab-icon size-3.5" />
            <span class="space-tab-label">{tab.label}</span>
          </button>
        {/each}
      </div>
      <button
        class="new-chat-btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors"
        onclick={createForActiveSpace}
      >
        <Plus class="size-4 shrink-0" />
        <span class="btn-label">{newButtonLabel}</span>
      </button>

      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        onclick={() => { appStore.artifactSettingsOpen = true; }}
        title="Artifacts"
      >
        <Puzzle class="size-4 shrink-0" />
        <span class="btn-label">Artifacts</span>
      </button>
    </div>

    {#if isSearching || searchFocused}
      <div class="pb-3">
        <label class="relative block">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={`color: ${sidebarIconColor};`} />
          <input
            bind:value={search}
            onfocus={() => (searchFocused = true)}
            onblur={() => (searchFocused = false)}
            class="search-input w-full rounded-[var(--radius-sm)] py-1.5 pl-8 pr-8 text-[14px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)]"
            class:focused={searchFocused}
            placeholder={$t('sidebar.searchPlaceholder')}
            type="text"
          />
          {#if isSearching}
            <button
              type="button"
              class="clear-btn absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5"
              onclick={() => (search = '')}
              aria-label="Clear search"
            >
              <X class="h-3 w-3" style={`color: ${sidebarIconColor};`} />
            </button>
          {/if}
        </label>
        {#if isSearching}
          <p class="mt-1 px-0.5 text-[11px] text-[var(--text-muted)]">
            {matchCount} {matchCount === 1 ? 'result' : 'results'}
          </p>
        {/if}
      </div>
    {/if}

    <div class="chat-list flex-1 overflow-y-auto">
      {#if groupedChats.length}
        {#each groupedChats as group (group.key)}
          {@const isCollapsed = !isSearching && collapsedGroups.has(group.key)}
          <div class="mb-1.5">
            <button
              type="button"
              class="group-label w-full cursor-pointer px-2 pb-1 pt-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
              aria-expanded={!isCollapsed}
              onclick={() => toggleGroup(group.key)}
            >
              {group.label}
            </button>
            {#if !isCollapsed}
            <div class="space-y-0.5" transition:slide={{ duration: 140 }}>
              {#each group.chats as chat (chat.id)}
                <div
                  class={`chat-item group relative flex w-full cursor-pointer items-center justify-between px-2.5 py-[5px] text-left transition ${appStore.currentChatId === chat.id ? 'is-active' : ''}`}
                  role="button"
                  tabindex="0"
                  onclick={() => appStore.selectChat(chat.id)}
                  ondblclick={() => startRename(chat.id, chat.title)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      appStore.selectChat(chat.id);
                    }
                  }}
                >
                  <div class="min-w-0 flex-1 pr-1">
                    {#if renamingChatId === chat.id}
                      <input
                        bind:this={renameInputEl}
                        class="chat-rename-input w-full"
                        bind:value={renameValue}
                        onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
                        onclick={(e) => e.stopPropagation()}
                        onkeydown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.stopPropagation();
                            commitRename(chat.id);
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            closeRename();
                          }
                        }}
                        onblur={() => closeRename()}
                        maxlength="120"
                      />
                    {:else}
                      <div class="chat-title truncate text-[14px]">{chat.title}</div>
                    {/if}
                  </div>
                  {#if renamingChatId !== chat.id}
                    <button
                      type="button"
                      class="menu-btn ml-0.5 rounded-[var(--radius-sm)] p-1 opacity-0 transition group-hover:opacity-100"
                      onclick={(e) => {
                        e.stopPropagation();
                        openMenuChatId = openMenuChatId === chat.id ? null : chat.id;
                      }}
                      aria-label="Chat options"
                    >
                      <MoreHorizontal class="h-3.5 w-3.5" style={`color: ${sidebarIconColor};`} />
                    </button>
                  {/if}

                  {#if openMenuChatId === chat.id}
                    <div
                      class="chat-menu absolute right-0 top-9 z-30 w-40 rounded-[var(--radius-md)]"
                      role="menu"
                      tabindex="-1"
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        class="menu-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[14px] transition"
                        onclick={(e) => { e.stopPropagation(); startRename(chat.id, chat.title); openMenuChatId = null; }}
                      >
                        <Pencil class="h-3.5 w-3.5" style={`color: ${sidebarIconColor};`} />
                        Rename
                      </button>
                      <button
                        type="button"
                        class="menu-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[14px] transition"
                        onclick={(e) => { e.stopPropagation(); exportChat(chat); openMenuChatId = null; }}
                      >
                        <FileDown class="h-3.5 w-3.5" style={`color: ${sidebarIconColor};`} />
                        Export
                      </button>
                      <button
                        type="button"
                        class="menu-item danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[14px] transition"
                        onclick={(e) => { e.stopPropagation(); confirmStore.show({ title: 'Delete Chat?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteChat(chat.id) }); openMenuChatId = null; }}
                      >
                        <Trash2 class="h-3.5 w-3.5" style={`color: ${sidebarIconColor};`} />
                        Delete
                      </button>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
            {/if}
          </div>
        {/each}
      {:else}
        <div class="empty-state flex flex-col items-center justify-center py-12 text-center">
          <div class="empty-icon mb-2 flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]">
            <MessageSquare class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
          </div>
          {#if isSearching}
            <p class="text-[14px] text-[var(--text-secondary)]">No matches</p>
            <p class="mt-0.5 text-[12px] text-[var(--text-muted)]">Try a different term</p>
          {:else}
            <p class="text-[14px] text-[var(--text-muted)]">No conversations yet</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="sidebar-footer px-0.5 py-2">
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        onclick={() => { appStore.modelManagerOpenSection = 'models'; appStore.modelManagerOpen = true; }}
        title="Models"
      >
        <Boxes class="size-4 shrink-0" />
        <span class="btn-label">Models</span>
      </button>
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        onclick={() => { appStore.modelManagerOpenSection = 'general'; appStore.modelManagerOpen = true; }}
        title="Settings"
      >
        <Settings class="size-4 shrink-0" />
        <span class="btn-label">Settings</span>
      </button>
    </div>
  </div>
</aside>


<style>
  .sidebar-brand-backdrop {
    --brand-texture-start: #b8d5ad;
    --brand-texture-end: #dfead9;
    --brand-rib-light: rgb(255 255 255 / 0.26);
    --brand-rib-dark: rgb(18 69 42 / 0.3);
    --brand-depth: rgb(23 78 48 / 0.22);
    pointer-events: none;
    position: absolute;
    inset: 0 0 auto;
    height: 3.5rem;
    overflow: hidden;
    border-radius: 0 0 0.875rem 0;
    -webkit-mask-image: radial-gradient(ellipse 100% 100% at 0 0, #000 0%, #000 46%, rgb(0 0 0 / 0.86) 56%, rgb(0 0 0 / 0.54) 68%, rgb(0 0 0 / 0.18) 80%, transparent 92%);
    mask-image: radial-gradient(ellipse 100% 100% at 0 0, #000 0%, #000 46%, rgb(0 0 0 / 0.86) 56%, rgb(0 0 0 / 0.54) 68%, rgb(0 0 0 / 0.18) 80%, transparent 92%);
    background: radial-gradient(ellipse 92% 58% at 42% 118%, var(--brand-depth) 0%, transparent 72%), linear-gradient(110deg, var(--brand-texture-start), var(--brand-texture-end));
  }

  :global(.sidebar-brand-mark .brand-mark__flaxeo) {
    color: #fff !important;
  }

  :global(.sidebar-brand-mark) {
    align-self: flex-start;
    min-width: 0;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    background: rgb(7 20 12 / 0.92) !important;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.14);
  }

  :global(.sidebar-brand-mark .brand-mark__chat) {
    color: rgb(255 255 255 / 0.85) !important;
  }

  :global(.dark .sidebar-brand-mark .brand-mark__flaxeo) {
    color: #07140c !important;
  }

  :global(.dark .sidebar-brand-mark) {
    background: rgb(232 241 235 / 0.9) !important;
  }

  :global(.dark .sidebar-brand-mark .brand-mark__chat) {
    color: rgb(7 20 12 / 0.78) !important;
  }

  .sidebar-brand-backdrop__texture {
    position: absolute;
    inset: -8%;
    width: 116%;
    height: 116%;
    transform-origin: center;
    animation: sidebar-brand-texture-drift 12s ease-in-out infinite alternate;
  }

  .sidebar-brand-backdrop__rib {
    fill: none;
    vector-effect: non-scaling-stroke;
  }

  .sidebar-brand-backdrop__rib--shadow {
    stroke: var(--brand-rib-dark);
    stroke-width: 4;
  }

  .sidebar-brand-backdrop__rib--light {
    stroke: var(--brand-rib-light);
    stroke-width: 1.5;
  }

  :global(.dark) .sidebar-brand-backdrop {
    --brand-texture-start: #103e31;
    --brand-texture-end: #0a241c;
    --brand-rib-light: rgb(132 190 157 / 0.2);
    --brand-rib-dark: rgb(1 17 11 / 0.42);
    --brand-depth: rgb(0 10 6 / 0.34);
  }

  @keyframes sidebar-brand-texture-drift {
    0% { transform: translate3d(-2%, -1%, 0) scale(1.02); }
    48% { transform: translate3d(1.5%, 1%, 0) scale(1.045); }
    100% { transform: translate3d(-0.5%, 2%, 0) scale(1.025); }
  }

  @media (prefers-reduced-motion: reduce) {
    .sidebar-brand-backdrop__texture {
      animation: none;
      transform: none;
    }
  }

  .new-chat-btn {
    color: var(--sidebar-foreground);
    background: transparent;
    border: none;
  }

  .space-tabs {
    display: flex;
    gap: 2px;
    border-radius: var(--radius-md);
    background: var(--sidebar-accent);
    border: 1px solid var(--sidebar-border);
    padding: 2px;
  }

  .space-tab {
    min-width: 0;
    flex: 1 1 0;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    border: none;
    border-radius: calc(var(--radius-md) - 2px);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: background-color 150ms ease, color 150ms ease;
  }

  .space-tab-icon {
    flex-shrink: 0;
  }

  .space-tab-label {
    display: inline;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .space-tab:hover:not(.active) {
    color: var(--sidebar-foreground);
    background: color-mix(in srgb, var(--sidebar-foreground) 6%, transparent);
  }

  .space-tab.active {
    background: var(--sidebar-primary);
    color: var(--sidebar-primary-foreground);
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

  .search-input {
    background: var(--sidebar-accent);
    border: 1px solid var(--sidebar-border);
    color: var(--sidebar-foreground);
  }

  .search-input.focused {
    border-color: var(--sidebar-ring);
    background: var(--background);
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--sidebar-ring) 25%, transparent);
  }

  .search-input::placeholder {
    color: var(--muted-foreground);
  }

  .clear-btn {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
  }

  .clear-btn:hover {
    color: var(--sidebar-foreground);
    background: var(--sidebar-accent);
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

  .chat-item {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    transition: background-color 150ms ease, color 150ms ease;
  }

  .chat-item:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .chat-item.is-active {
    background: var(--sidebar-primary);
    color: var(--sidebar-primary-foreground);
  }

  .chat-item.is-active .chat-title,
  .chat-item.is-active .menu-btn {
    color: inherit;
  }


  .chat-rename-input {
    height: 30px;
    border-radius: var(--radius-md);
    border: 1px solid var(--sidebar-border);
    background: var(--background);
    color: var(--sidebar-foreground);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.2;
    padding: 0 10px;
    outline: none;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }

  .chat-rename-input:focus {
    border-color: var(--sidebar-ring);
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--sidebar-ring) 25%, transparent);
  }

  .menu-btn {
    color: inherit;
    opacity: 0.7;
    background: transparent;
    border: none;
  }

  .menu-btn:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--sidebar-foreground) 10%, transparent);
  }

  .chat-menu {
    background: var(--popover);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    padding: 4px;
    border-radius: var(--radius-lg);
  }

  .menu-item {
    color: var(--foreground);
    border-radius: var(--radius-sm);
    border: none;
  }

  .menu-item:hover {
    background: var(--muted);
  }

  .menu-item.danger {
    color: var(--error);
  }

  .menu-item.danger:hover {
    background: var(--error-bg);
  }

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
</style>
