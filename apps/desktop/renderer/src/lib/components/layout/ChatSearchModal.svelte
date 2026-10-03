<svelte:options runes={true} />

<script lang="ts">
  import { displayChatTitle } from '$lib/features/shared/session-title';
  import { copy } from '$lib/copy';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { t } from 'svelte-i18n';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { Search, X, MessageSquare, Plus, ExternalLink, Pencil, Trash2 } from 'lucide-svelte';
  import Message from '$lib/features/chat/thread/Message.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { countOf } from '$lib/utils/format';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import type { ChatSession } from '$lib/types/chat';
  import { getSpaceForSession } from '$lib/features/shared/session-guards';
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
    if (diff === 0) return $t('sidebar.today');
    if (diff === 1) return $t('sidebar.yesterday');
    if (diff <= 6) return $t('search.daysAgo', { values: { n: diff } });
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Scope search to active space only via store boundary, not inline filter.
  // Bots hold no chats of any space: nothing from Home or Roleplay leaks in.
  const spaceChats = $derived.by(() => {
    return appStore.botsOpen ? [] : appStore.getSessionsForSpace(appStore.activeSpace);
  });

  interface SearchHit {
    chat: ChatSession;
    /** First message containing the query — the jump target. */
    matchMessageId: string | null;
    snippet: string | null;
  }

  const results = $derived.by((): SearchHit[] => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [...spaceChats]
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .map((chat) => ({ chat, matchMessageId: null, snippet: null }));
    }
    const hits: SearchHit[] = [];
    for (const chat of spaceChats) {
      const titleHit = chat.title.toLowerCase().includes(q);
      const msg = chat.messages.find((m) => m.content.toLowerCase().includes(q));
      if (!titleHit && !msg) continue;
      let snippet: string | null = null;
      if (msg) {
        const at = msg.content.toLowerCase().indexOf(q);
        const start = Math.max(0, at - 48);
        const end = at + q.length + 90;
        snippet = (start > 0 ? '…' : '') + msg.content.slice(start, end).trim() + (end < msg.content.length ? '…' : '');
      }
      hits.push({ chat, matchMessageId: msg?.id ?? null, snippet });
    }
    return hits.sort((a, b) => (b.chat.updatedAt || b.chat.createdAt) - (a.chat.updatedAt || a.chat.createdAt));
  });

  const previewChat = $derived(selectedIndex >= 0 ? results[selectedIndex]?.chat ?? null : null);

  // Reset selection when results change
  $effect(() => {
    query;
    results[0]?.chat.id;
    selectedIndex = -1;
  });

  $effect(() => {
    previewChat?.id;
    void tick().then(() => {
      if (previewContainer) previewContainer.scrollTop = 0;
    });
  });

  function selectChat(id: string, messageId?: string | null) {
    appStore.selectChat(id);
    appStore.chatSearchOpen = false;
    if (!messageId) return;
    // Slots register after the thread renders; then the existing registry
    // scrolls the matched message to center and pins its actions.
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('scroll-to-chat-message', { detail: { messageId } }));
    }, 450);
  }

  // In Code a conversation lives in a project: start one in the active
  // project, or fall back to adding a project when there is none.
  const codeProject = $derived(
    appStore.activeSpace === 'code'
      ? codeStore.projectById(codeStore.activeProjectId) ?? codeStore.projects[0] ?? null
      : null
  );
  const newRowLabel = $derived(
    appStore.activeSpace !== 'code'
      ? $t('shortcuts.newChat')
      : codeProject
        ? `${$t('code.newConversation')} · ${codeProject.rootName}`
        : $t('code.addProject')
  );

  function createChat() {
    if (appStore.activeSpace === 'code') {
      if (codeProject) codeStore.newConversation(codeProject);
      else void codeStore.addProject();
    } else {
      appStore.createChat(appStore.activeSpace);
    }
    close();
  }

  function deleteChat(chat: ChatSession) {
    confirmStore.show({
      title: copy.confirm.deleteChat.title,
      message: `“${displayChatTitle(chat)}” — ${copy.confirm.deleteChat.message}`,
      confirmLabel: copy.actions.delete,
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
      // Enter with no explicit selection opens the top result.
      const idx = selectedIndex >= 0 ? selectedIndex : 0;
      const hit = results[idx];
      if (hit) selectChat(hit.chat.id, hit.matchMessageId);
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
  class="chat-search-backdrop ui-modal-backdrop items-start px-4 pt-[8vh]"
  use:modalLayer={{ onclose: close }}
  onclick={close}
  onkeydown={handleKeydown}
>
  <div
    class="chat-search-dialog ui-menu flex w-full max-w-5xl flex-col overflow-hidden !p-0"
    role="dialog"
    aria-modal="true"
    aria-label={$t('shortcuts.search')}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="search-header flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
      <Search class="size-4 shrink-0 text-muted-foreground" />
      <input
        bind:this={searchInput}
        bind:value={query}
        class="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={appStore.activeSpace === 'code'
          ? $t('search.placeholderCode')
          : $t('search.placeholderChats')}
        type="text"
      />
      {#if query}
        <button
          type="button"
          class="ui-icon-button is-sm"
          onclick={() => (query = '')}
          aria-label={$t('search.clear')}
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
            <span class="truncate">{newRowLabel}</span>
          </button>
        </div>
        <div bind:this={resultsContainer} class="min-h-0 flex-1 overflow-y-auto p-2">
          {#if results.length === 0}
            <div class="flex h-full min-h-56 flex-col items-center justify-center px-6 text-center">
              <div class="mb-3 flex size-10 items-center justify-center rounded-full bg-muted">
                <MessageSquare class="size-5 text-muted-foreground" />
              </div>
              <p class="text-sm font-medium text-foreground">
                {query ? $t('search.noMatches') : $t('search.empty')}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                {query ? $t('search.noMatchesHint') : $t('search.emptyHint')}
              </p>
            </div>
          {:else}
            <div class="space-y-1">
              {#each results as hit, i (hit.chat.id)}
                <div
                  class="search-result"
                  class:is-selected={i === selectedIndex}
                  data-selected={i === selectedIndex}
                  onmouseenter={() => (selectedIndex = i)}
                  onclick={() => selectChat(hit.chat.id, hit.matchMessageId)}
                >
                  {#if renamingChatId === hit.chat.id}
                    <input
                      bind:this={renameInputEl}
                      class="chat-rename-input min-w-0 flex-1"
                      bind:value={renameValue}
                      onclick={(event) => event.stopPropagation()}
                      onkeydown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename(hit.chat.id);
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          closeRename();
                        }
                      }}
                      onblur={() => commitRename(hit.chat.id)}
                    />
                  {:else}
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-foreground">{displayChatTitle(hit.chat)}</p>
                      {#if hit.snippet}
                        <p class="result-snippet mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{hit.snippet}</p>
                      {/if}
                    </div>
                  {/if}
                  <div class="result-trailing">
                    <span class="result-date text-[12px] text-muted-foreground">{relativeDate(hit.chat.updatedAt || hit.chat.createdAt)}</span>
                    <div class="result-actions flex items-center gap-0.5">
                      <button type="button" class="result-action" onclick={(e) => { e.stopPropagation(); selectChat(hit.chat.id, hit.matchMessageId); }} aria-label={`${copy.actions.open}: ${displayChatTitle(hit.chat)}`} title={copy.actions.open}>
                        <ExternalLink class="size-3.5" />
                      </button>
                      <button type="button" class="result-action" onclick={(e) => { e.stopPropagation(); startRename(hit.chat); }} aria-label={`${copy.actions.rename}: ${displayChatTitle(hit.chat)}`} title={copy.actions.rename}>
                        <Pencil class="size-3.5" />
                      </button>
                      <button type="button" class="result-action danger" onclick={(e) => { e.stopPropagation(); deleteChat(hit.chat); }} aria-label={`${copy.actions.delete}: ${displayChatTitle(hit.chat)}`} title={copy.actions.delete}>
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
              <div class="flex h-full items-center justify-center text-sm text-muted-foreground">{$t('search.previewEmpty')}</div>
            {:else}
              <div class="preview-conversation mx-auto flex max-w-[55rem] flex-col gap-7">
                {#each previewChat.messages as message (message.id)}
                  <Message {message} contextMode={getSpaceForSession(previewChat)} />
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
            <p class="text-sm font-medium text-foreground">{$t('search.previewPick')}</p>
            <p class="mt-1 text-xs text-muted-foreground">{$t('search.previewHint')}</p>
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
