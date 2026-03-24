<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { isTauri } from '$lib/services/tauri';
  import { Boxes, Cpu, FileDown, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Settings2, Trash2, X } from 'lucide-svelte';
  import RenameChatModal from './RenameChatModal.svelte';

  let search = $state('');
  let searchFocused = $state(false);
  let renamingChatId = $state<string | null>(null);
  let renamingChatTitle = $state('');
  let renameValue = $state('');
  let openMenuChatId = $state<string | null>(null);

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(ts: number): string {
    const now = startOfDay(Date.now());
    const day = startOfDay(ts);
    const diff = Math.floor((now - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff <= 6) return 'This week';
    return 'Older';
  }

  const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'Older'];

  const filteredChats = $derived.by(() => {
    const query = search.trim().toLowerCase();
    if (!query) return appStore.chats;
    return appStore.chats.filter((chat) => {
      return (
        chat.title.toLowerCase().includes(query) ||
        chat.messages.some((message) => message.content.toLowerCase().includes(query))
      );
    });
  });

  const groupedChats = $derived.by(() => {
    const groups: Record<string, typeof filteredChats> = {};
    for (const chat of filteredChats) {
      const label = groupLabel(chat.updatedAt || chat.createdAt);
      if (!groups[label]) groups[label] = [];
      groups[label].push(chat);
    }
    return GROUP_ORDER.filter((g) => groups[g]?.length).map((g) => ({ label: g, chats: groups[g] }));
  });

  const isSearching = $derived(search.trim().length > 0);
  const matchCount = $derived(filteredChats.length);

  const activeModel = $derived(
    appStore.backendMode === 'local' ? modelsStore.status?.active_model : null
  );

  function startRename(chatId: string, title: string) {
    renamingChatId = chatId;
    renamingChatTitle = title;
  }

  function closeRename() {
    renamingChatId = null;
    renamingChatTitle = '';
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

<aside class="sidebar flex h-full w-[260px] shrink-0 flex-col">
  <div class="flex min-h-0 flex-1 flex-col px-2 pt-2 pb-1">

    <!-- Top actions row: New Chat + Search toggle -->
    <div class="flex items-center gap-1 px-1 pb-2">
      <button
        class="new-chat-btn flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition"
        onclick={() => appStore.createChat()}
      >
        <Plus class="h-4 w-4" />
        New Chat
      </button>
      <button
        class="sidebar-icon-btn flex h-8 w-8 items-center justify-center rounded-lg transition"
        onclick={() => (appStore.chatSearchOpen = true)}
        aria-label="Search chats"
        title="Search conversations (Ctrl+Shift+K)"
      >
        <Search class="h-4 w-4" />
      </button>
    </div>

    <!-- Inline search (shown when focused or has value) -->
    {#if isSearching || searchFocused}
      <div class="px-1 pb-2">
        <label class="relative block">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            bind:value={search}
            onfocus={() => (searchFocused = true)}
            onblur={() => (searchFocused = false)}
            class="search-input w-full rounded-lg py-1.5 pl-8 pr-8 text-[13px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)]"
            class:focused={searchFocused}
            placeholder="Search chats..."
            type="text"
          />
          {#if isSearching}
            <button
              type="button"
              class="clear-btn absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5"
              onclick={() => (search = '')}
              aria-label="Clear search"
            >
              <X class="h-3 w-3" />
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

    <!-- Chat list -->
    <div class="chat-list flex-1 overflow-y-auto px-0.5">
      {#if groupedChats.length}
        {#each groupedChats as group (group.label)}
          <div class="mb-1">
            <div class="group-label px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              {group.label}
            </div>
            <div class="space-y-px">
              {#each group.chats as chat (chat.id)}
                <div
                  class={`chat-item group relative flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left transition ${appStore.currentChatId === chat.id ? 'is-active' : ''}`}
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
                    <div class="chat-title truncate text-[13px] font-medium">{chat.title}</div>
                    <div class="chat-date mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{new Date(chat.updatedAt || chat.createdAt).toLocaleDateString()}</div>
                  </div>
                  <button
                    type="button"
                    class="menu-btn ml-0.5 rounded-md p-1 opacity-0 transition group-hover:opacity-100"
                    onclick={(e) => {
                      e.stopPropagation();
                      openMenuChatId = openMenuChatId === chat.id ? null : chat.id;
                    }}
                    aria-label="Chat options"
                  >
                    <MoreHorizontal class="h-3.5 w-3.5" />
                  </button>

                  {#if openMenuChatId === chat.id}
                    <div
                      class="chat-menu absolute right-0 top-10 z-30 w-40 rounded-lg"
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
                        <Pencil class="h-3.5 w-3.5" />
                        Rename
                      </button>
                      <button
                        type="button"
                        class="menu-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition"
                        onclick={(e) => { e.stopPropagation(); exportChat(chat); openMenuChatId = null; }}
                      >
                        <FileDown class="h-3.5 w-3.5" />
                        Export
                      </button>
                      <button
                        type="button"
                        class="menu-item danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition"
                        onclick={(e) => { e.stopPropagation(); confirmStore.show({ title: 'Delete Chat?', message: 'This cannot be undone.', danger: true, onConfirm: () => appStore.deleteChat(chat.id) }); openMenuChatId = null; }}
                      >
                        <Trash2 class="h-3.5 w-3.5" />
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
          <div class="empty-icon mb-2 flex h-8 w-8 items-center justify-center rounded-lg">
            <MessageSquare class="h-4 w-4 text-[var(--text-muted)]" />
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

    <!-- Footer: Model Hub, Runtime, Settings -->
    <div class="sidebar-footer space-y-px px-0.5 py-1.5">
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition"
        onclick={() => (appStore.modelManagerOpen = true)}
        title="Manage models"
      >
        <Boxes class="h-4 w-4" />
        Model Hub
      </button>
      {#if isTauri()}
        <button
          class="sidebar-btn flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition"
          onclick={() => (appStore.runtimeManagerOpen = true)}
          title="Manage local runtime"
        >
          <Cpu class="h-4 w-4" />
          Runtime
        </button>
      {/if}
      <button
        class="sidebar-btn flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition"
        onclick={() => (appStore.settingsOpen = true)}
        title="Settings"
      >
        <Settings2 class="h-4 w-4" />
        Settings
      </button>
    </div>
  </div>
</aside>

{#if renamingChatId}
  <RenameChatModal
    chatId={renamingChatId}
    currentTitle={renamingChatTitle}
    onClose={closeRename}
  />
{/if}

<style>
  .sidebar {
    background: var(--chat-bg, var(--background));
  }

  .new-chat-btn {
    color: var(--text-secondary);
    background: transparent;
  }

  .new-chat-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .sidebar-icon-btn {
    color: var(--text-muted);
    background: transparent;
  }

  .sidebar-icon-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .search-input {
    background: var(--surface-highlight);
    border: 1px solid transparent;
    color: var(--text);
  }

  .search-input.focused {
    border-color: var(--border);
    background: var(--surface);
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .clear-btn {
    color: var(--text-muted);
    background: transparent;
  }

  .clear-btn:hover {
    color: var(--text);
  }

  .chat-item {
    color: var(--text-secondary);
  }

  .chat-item:hover {
    background: var(--surface-highlight);
    color: var(--text);
  }

  .chat-item.is-active {
    background: var(--surface-highlight);
    color: var(--text);
  }

  .chat-item.is-active .chat-title {
    color: var(--text);
  }

  .menu-btn {
    color: var(--text-muted);
    background: transparent;
  }

  .menu-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }

  .chat-menu {
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-l);
    padding: 3px;
  }

  .menu-item {
    color: var(--text);
    border-radius: 6px;
  }

  .menu-item:hover {
    background: var(--surface-highlight);
  }

  .menu-item.danger {
    color: var(--error);
  }

  .menu-item.danger:hover {
    background: var(--error-bg);
  }

  :global(.dark) .menu-item.danger {
    color: var(--error);
  }

  :global(.dark) .menu-item.danger:hover {
    background: var(--error-bg);
  }

  .empty-icon {
    background: var(--surface-highlight);
  }

  .sidebar-footer {
    border-top: none;
  }

  .sidebar-btn {
    color: var(--text-secondary);
    background: transparent;
  }

  .sidebar-btn:hover {
    color: var(--text);
    background: var(--surface-highlight);
  }
</style>
