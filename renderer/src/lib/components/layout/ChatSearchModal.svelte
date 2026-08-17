<svelte:options runes={true} />

<script lang="ts">
  import { Search, X, MessageSquare, Plus, ExternalLink, Pencil, Trash2 } from 'lucide-svelte';
  import Message from '$lib/features/chat/thread/Message.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { countOf } from '$lib/utils/format';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import type { ChatSession } from '$lib/types/chat';
  import { onMount, tick } from 'svelte';

  let searchInput: HTMLInputElement | undefined = $state();
  let query = $state('');
  let selectedIndex = $state(-1);
  let resultsContainer: HTMLDivElement | undefined = $state();
  let previewContainer: HTMLDivElement | undefined = $state();
  let renamingChatId = $state<string | null>(null);
  let renameValue = $state('');
  let renameOriginal = $state('');
  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);

  /** Rename in place, matching the sidebar, rather than stacking a second modal. */
  function startRename(chat: ChatSession) {
    renamingChatId = chat.id;
    renameOriginal = chat.title || '';
    renameValue = chat.title || '';
    void tick().then(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    });
  }

  function closeRename() {
    renamingChatId = null;
    renameValue = '';
    renameOriginal = '';
  }

  function commitRename(chatId: string) {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renameOriginal) appStore.renameChat(chatId, trimmed);
    closeRename();
  }

  function startOfDay(ts: number) {
    const date = new Date(ts);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function relativeDate(ts: number): string {
    const diff = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff <= 6) return `${diff}d ago`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Scope search to the active space only (Chat | Work isolation)
  const spaceChats = $derived.by(() => {
    return appStore.chats.filter((chat) => (chat.contextMode || 'chat') === appStore.activeSpace);
  });

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [...spaceChats]
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    }
    return spaceChats
      .filter(chat =>
        chat.title.toLowerCase().includes(q) ||
        chat.messages.some(m => m.content.toLowerCase().includes(q))
      )
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  });

  const previewChat = $derived(selectedIndex >= 0 ? results[selectedIndex] || null : null);

  // Reset selection when results change
  $effect(() => {
    query;
    results[0]?.id;
    selectedIndex = -1;
  });

  $effect(() => {
    previewChat?.id;
    void tick().then(() => {
      if (previewContainer) previewContainer.scrollTop = 0;
    });
  });

  function selectChat(id: string) {
    appStore.selectChat(id);
    appStore.chatSearchOpen = false;
  }

  function createChat() {
    appStore.createChat(appStore.activeSpace);
    close();
  }

  function deleteChat(chat: ChatSession) {
    confirmStore.show({
      title: 'Delete Chat?',
      message: `Delete “${chat.title || 'New chat'}”? This cannot be undone.`,
      danger: true,
      onConfirm: () => appStore.deleteChat(chat.id)
    });
  }

  function close() {
    appStore.chatSearchOpen = false;
  }

  function scrollSelectedIntoView() {
    void tick().then(() => {
      const el = resultsContainer?.querySelector('[data-selected="true"]') as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = selectedIndex < 0 ? 0 : (selectedIndex + 1) % results.length;
        scrollSelectedIntoView();
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = selectedIndex < 0 ? results.length - 1 : (selectedIndex - 1 + results.length) % results.length;
        scrollSelectedIntoView();
      }
      return;
    }
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      if (results.length > 0 && results[selectedIndex]) {
        selectChat(results[selectedIndex].id);
      }
      return;
    }
  }

  onMount(() => {
    searchInput?.focus();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="chat-search-backdrop aui-modal-backdrop z-[250] items-start px-4 pt-[8vh]"
  onclick={close}
  onkeydown={handleKeydown}
>
  <div
    class="chat-search-dialog aui-menu flex w-full max-w-5xl flex-col overflow-hidden !p-0"
    role="dialog"
    aria-modal="true"
    aria-label="Search conversations"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="search-header flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
      <Search class="size-4 shrink-0 text-muted-foreground" />
      <input
        bind:this={searchInput}
        bind:value={query}
        class="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={appStore.activeSpace === 'work'
          ? 'Search work sessions...'
          : 'Search chats...'}
        type="text"
      />
      {#if query}
        <button
          type="button"
          class="aui-icon-button size-7"
          onclick={() => (query = '')}
          aria-label="Clear"
        >
          <X class="size-3.5" />
        </button>
      {/if}
      <span class="hidden shrink-0 text-xs text-muted-foreground sm:block">
        {countOf(results.length, 'conversation')}
      </span>
    </div>

    <div class="flex min-h-0 flex-1">
      <div class="results-pane flex w-80 shrink-0 flex-col border-r border-[var(--border-subtle)]">
        <div class="shrink-0 p-2">
          <button type="button" class="new-chat-row" onclick={createChat}>
            <Plus class="size-3.5" />
            <span>New chat</span>
          </button>
        </div>
        <div bind:this={resultsContainer} class="min-h-0 flex-1 overflow-y-auto p-2">
          {#if results.length === 0}
            <div class="flex h-full min-h-56 flex-col items-center justify-center px-6 text-center">
              <div class="mb-3 flex size-10 items-center justify-center rounded-full bg-muted">
                <MessageSquare class="size-5 text-muted-foreground" />
              </div>
              <p class="text-sm font-medium text-foreground">
                {query ? 'No matching conversations' : 'No conversations yet'}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {query ? 'Try a different title or phrase.' : 'Your conversations will appear here.'}
              </p>
            </div>
          {:else}
            <div class="space-y-1">
              {#each results as chat, i (chat.id)}
                <div
                  class="search-result"
                  class:is-selected={i === selectedIndex}
                  data-selected={i === selectedIndex}
                  onmouseenter={() => (selectedIndex = i)}
                >
                  {#if renamingChatId === chat.id}
                    <input
                      bind:this={renameInputEl}
                      class="chat-rename-input min-w-0 flex-1"
                      bind:value={renameValue}
                      onclick={(event) => event.stopPropagation()}
                      onkeydown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename(chat.id);
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          closeRename();
                        }
                      }}
                      onblur={() => commitRename(chat.id)}
                    />
                  {:else}
                    <p class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{chat.title || 'New chat'}</p>
                  {/if}
                  <div class="result-trailing">
                    <span class="result-date text-[11px] text-muted-foreground">{relativeDate(chat.updatedAt || chat.createdAt)}</span>
                    <div class="result-actions flex items-center gap-0.5">
                      <button type="button" class="result-action" onclick={() => selectChat(chat.id)} aria-label={`Open ${chat.title || 'chat'}`} title="Open">
                        <ExternalLink class="size-3.5" />
                      </button>
                      <button type="button" class="result-action" onclick={() => startRename(chat)} aria-label={`Rename ${chat.title || 'chat'}`} title="Rename">
                        <Pencil class="size-3.5" />
                      </button>
                      <button type="button" class="result-action danger" onclick={() => deleteChat(chat)} aria-label={`Delete ${chat.title || 'chat'}`} title="Delete">
                        <Trash2 class="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <section class="chat-preview relative flex min-w-0 flex-1 flex-col bg-background" aria-label="Conversation preview">
        {#if previewChat}
          <div bind:this={previewContainer} class="preview-transcript min-h-0 flex-1 overflow-y-auto px-5 pb-20 pt-5">
            {#if previewChat.messages.length === 0}
              <div class="flex h-full items-center justify-center text-sm text-muted-foreground">This conversation is empty.</div>
            {:else}
              <div class="preview-conversation mx-auto flex max-w-[55rem] flex-col gap-7">
                {#each previewChat.messages as message (message.id)}
                  <Message {message} contextMode={previewChat.contextMode || 'chat'} />
                {/each}
              </div>
            {/if}
          </div>
          <!-- Floats over the transcript: a bordered footer strip cut the
               preview in half for a single action. -->
          <button
            type="button"
            class="open-chat-button open-chat-floating"
            onclick={() => selectChat(previewChat.id)}
          >
            Open conversation
          </button>
        {:else}
          <div class="flex h-full flex-col items-center justify-center px-6 text-center">
            <div class="mb-3 flex size-11 items-center justify-center rounded-lg bg-muted">
              <MessageSquare class="size-5 text-muted-foreground" />
            </div>
            <p class="text-sm font-medium text-foreground">Select a conversation to preview</p>
            <p class="mt-1 text-xs text-muted-foreground">Hover over a result or use the arrow keys.</p>
          </div>
        {/if}
      </section>
    </div>
  </div>
</div>



<style>
  .chat-search-dialog {
    height: min(76vh, 46rem);
    border-radius: var(--radius-2xl);
    background: var(--popover);
    box-shadow: var(--shadow-xl);
  }

  .new-chat-row {
    display: inline-flex;
    height: 2rem;
    align-items: center;
    gap: 0.45rem;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    padding: 0 0.75rem;
    color: var(--foreground);
    font-size: 0.75rem;
    font-weight: 500;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .new-chat-row:hover {
    background: var(--surface-hover);
  }

  .search-result {
    display: flex;
    width: 100%;
    min-height: 2.5rem;
    align-items: center;
    gap: 0.5rem;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    padding: 0.35rem 0.5rem 0.35rem 0.85rem;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .search-result:hover,
  .search-result.is-selected,
  .search-result:focus-within {
    background: var(--surface-hover);
  }

  .result-trailing {
    position: relative;
    display: flex;
    width: 5.5rem;
    min-height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
  }

  .result-date {
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .result-actions {
    position: absolute;
    right: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .search-result:hover .result-date,
  .search-result.is-selected .result-date,
  .search-result:focus-within .result-date {
    opacity: 0;
  }

  .search-result:hover .result-actions,
  .search-result.is-selected .result-actions,
  .search-result:focus-within .result-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .result-action {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .result-action:hover {
    background: var(--surface-active);
    color: var(--foreground);
  }

  .result-action.danger:hover {
    background: var(--error-bg);
    color: var(--error);
  }

  .result-action:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -1px;
  }

  .preview-conversation {
    pointer-events: none;
  }

  .open-chat-floating {
    position: absolute;
    right: 1.25rem;
    bottom: 1.25rem;
    z-index: 2;
    box-shadow: var(--shadow-lg);
  }

  .open-chat-button {
    height: 2.25rem;
    border: none;
    border-radius: var(--radius-full);
    background: var(--primary);
    padding: 0 1rem;
    color: var(--primary-foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  @media (max-width: 760px) {
    .chat-search-backdrop {
      padding: 1rem;
    }

    .chat-search-dialog {
      height: calc(100vh - 2rem);
    }

    .results-pane {
      width: 100%;
      border-right: none;
    }

    .chat-preview {
      display: none;
    }
  }
</style>
