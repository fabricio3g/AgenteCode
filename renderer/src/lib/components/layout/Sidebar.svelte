<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';
  import { t } from 'svelte-i18n';
  import { Boxes, Code2, FileDown, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-svelte';

  let search = $state('');
  let searchFocused = $state(false);
  let debouncedSearch = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let renamingChatId = $state<string | null>(null);
  let renamingChatTitle = $state('');
  let renameValue = $state('');
  let openMenuChatId = $state<string | null>(null);
  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(ts: number): string {
    const now = startOfDay(Date.now());
    const day = startOfDay(ts);
    const diff = Math.floor((now - day) / 86400000);
    if (diff === 0) return $t('sidebar.today') || 'Today';
    if (diff === 1) return $t('sidebar.yesterday') || 'Yesterday';
    if (diff <= 6) return $t('sidebar.thisWeek') || 'This week';
    return $t('sidebar.older') || 'Older';
  }

  const filteredChats = $derived.by(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return appStore.chats;
    return appStore.chats.filter((chat) => {
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
  const sidebarIconColor = $derived(themeStore.current === 'dark' ? '#ffffff' : '#0A0A0A');

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
    const close = () => { openMenuChatId = null; };
    const timer = setTimeout(() => {
      document.addEventListener('click', close, { once: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  });
</script>

<aside class="sidebar flex h-full w-full flex-col">
  <div class="flex min-h-0 flex-1 flex-col px-3 pt-0 pb-1">

    <div class="flex flex-col gap-1.5 pb-3 pt-2">
      <button
        class="new-chat-btn flex flex-1 items-center gap-2 px-3 py-[5px] text-[13px] font-medium transition"
        onclick={() => appStore.createChat()}
      >
        <span class="plus-badge flex items-center justify-center">
          <Plus class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
        </span>
        <span class="btn-label">{$t('sidebar.newChat')}</span>
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
            class="search-input w-full rounded-[var(--radius-sm)] py-1.5 pl-8 pr-8 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)]"
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
          <div class="mb-1.5">
            <div class="group-label px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {group.label}
            </div>
            <div class="space-y-0.5">
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
                      <div class="chat-title truncate text-[13px]">{chat.title}</div>
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
                        class="menu-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition"
                        onclick={(e) => { e.stopPropagation(); startRename(chat.id, chat.title); openMenuChatId = null; }}
                      >
                        <Pencil class="h-3.5 w-3.5" style={`color: ${sidebarIconColor};`} />
                        Rename
                      </button>
                      <button
                        type="button"
                        class="menu-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition"
                        onclick={(e) => { e.stopPropagation(); exportChat(chat); openMenuChatId = null; }}
                      >
                        <FileDown class="h-3.5 w-3.5" style={`color: ${sidebarIconColor};`} />
                        Export
                      </button>
                      <button
                        type="button"
                        class="menu-item danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition"
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
          </div>
        {/each}
      {:else}
        <div class="empty-state flex flex-col items-center justify-center py-12 text-center">
          <div class="empty-icon mb-2 flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]">
            <MessageSquare class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
          </div>
          {#if isSearching}
            <p class="text-[13px] text-[var(--text-secondary)]">No matches</p>
            <p class="mt-0.5 text-[11px] text-[var(--text-muted)]">Try a different term</p>
          {:else}
            <p class="text-[13px] text-[var(--text-muted)]">No conversations yet</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="sidebar-footer px-0.5 py-2">
      <button
        class={`sidebar-btn flex w-full items-center gap-2 px-3 py-[5px] text-[13px] transition ${appStore.mainView === 'developer' ? 'is-active' : ''}`}
        onclick={() => appStore.openDeveloperMode()}
        title="Developer Mode"
      >
        <Code2 class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
        <span class="btn-label">Developer Mode</span>
      </button>
      <button
        class="sidebar-btn flex w-full items-center gap-2 px-3 py-[5px] text-[13px] transition"
        onclick={() => { appStore.modelManagerOpenSection = 'models'; appStore.modelManagerOpen = true; }}
        title="Manage models"
      >
        <Boxes class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
        <span class="btn-label">Model Hub</span>
      </button>
      <button
        class={`sidebar-btn roleplay-btn flex w-full items-center gap-2 px-3 py-[5px] text-[13px] transition ${appStore.shellMode === 'roleplay' ? 'is-active' : ''}`}
        onclick={() => appStore.toggleRoleplayMode()}
        title="Roleplay"
      >
        <Sparkles class="h-4 w-4" style={`color: ${sidebarIconColor};`} />
        <span class="btn-label">Roleplay</span>
      </button>
    </div>
  </div>
</aside>


<style>
  .new-chat-btn {
    color: var(--text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
  }

  .new-chat-btn:hover {
    background: var(--surface-hover);
  }

  .new-chat-btn:hover .plus-badge {
    transform: rotate(-12deg) scale(1.05);
  }

  .plus-badge {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface-hover);
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    flex-shrink: 0;
  }

  .btn-label {
    color: var(--text);
  }

  .search-input {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text);
  }

  .search-input.focused {
    border-color: var(--border-active);
    background: var(--surface);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .clear-btn {
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
  }

  .clear-btn:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  .chat-item {
    color: var(--text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .chat-item:hover {
    background: var(--surface-hover);
  }

  .chat-item.is-active {
    background: var(--surface-hover);
  }

  .chat-rename-input {
    height: 30px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface-hover) 70%, var(--surface));
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.2;
    padding: 0 10px;
    outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
  }

  .chat-rename-input::selection {
    background: color-mix(in srgb, var(--accent) 28%, transparent);
  }

  .chat-rename-input:focus {
    border-color: var(--border-active);
    background: var(--surface);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .menu-btn {
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
  }

  .menu-btn:hover {
    color: var(--text);
    background: var(--surface-hover);
    border-color: var(--border);
  }

  .chat-menu {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-xl);
    padding: 4px;
    border-radius: var(--radius-lg);
  }

  .menu-item {
    color: var(--text);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
  }

  .menu-item:hover {
    background: var(--surface-hover);
    border-color: var(--border);
  }

  .menu-item.danger {
    color: var(--error);
  }

  .menu-item.danger:hover {
    background: var(--error-bg);
    border-color: var(--error-border);
  }

  .empty-icon {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.5rem;
  }

  .sidebar-btn {
    color: var(--text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
  }

  .sidebar-btn:hover {
    background: var(--surface-hover);
  }

  .sidebar-btn.is-active {
    background: var(--surface-hover);
  }

  .sidebar-btn.roleplay-btn.is-active {
    background: var(--surface-hover);
    border-color: var(--border);
  }

  .sidebar-btn.roleplay-btn.is-active .btn-label {
    color: var(--text-secondary);
  }

  :global(.sidebar-btn svg) {
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  :global(.sidebar-btn:hover svg) {
    transform: rotate(-8deg);
  }
</style>
