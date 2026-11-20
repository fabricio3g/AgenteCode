<svelte:options runes={true} />

<!--
  Search conversations: two clean modes toggled right in the header (persisted
  in localStorage):
  - Preview mode (split view): hovering or arrow-moving over a result renders
    the actual scrollable conversation on the right before you open it.
  - Simple mode (single column): compact command-palette list.

  Arrows move, Enter opens, Escape or a click outside closes.
-->

<script lang="ts">
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import UiListRow from '$lib/components/ui/ListRow.svelte';
  import UiButton from '$lib/components/ui/Button.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { MessageSquare, PanelRight, Plus, Search } from '$lib/icons';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { displayChatTitle } from '$lib/features/shared/session-title';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { countOf } from '$lib/utils/format';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { backdropIn, backdropOut, dialogOut, flyAndScale } from '$lib/utils/transitions';
  import type { ChatSession } from '$lib/types/chat';
  import { loadChatMessagesFromDb, searchChatsInDb } from '$lib/utils/storage';

  type PreviewMessage = ChatSession['messages'][number];

  const PREVIEW_KEY = 'agente.search.preview';

  function readPreviewPref(): boolean {
    try {
      const raw = localStorage.getItem(PREVIEW_KEY);
      return raw === null ? true : raw === '1';
    } catch {
      return true;
    }
  }

  let searchInput = $state<HTMLInputElement>();
  let list = $state<HTMLDivElement>();
  let previewScroll = $state<HTMLDivElement>();
  let query = $state('');
  /** -1 is the "new conversation" row; 0.. are results. */
  let selectedIndex = $state(0);
  let previewEnabled = $state(readPreviewPref());

  function togglePreview() {
    previewEnabled = !previewEnabled;
    try {
      localStorage.setItem(PREVIEW_KEY, previewEnabled ? '1' : '0');
    } catch {
      // ignore storage errors
    }
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

  // The open space's conversations only; Bots hold no chats.
  const spaceChats = $derived(appStore.getSessionsForSpace(appStore.activeSpace));

  interface SearchHit {
    chat: ChatSession;
    /** First message containing the query — where opening it scrolls to. */
    matchMessageId: string | null;
    snippet: string | null;
  }

  let dbMatches = $state<Record<string, { messageId: string; content: string }>>({});
  $effect(() => {
    const q = query.trim();
    const unloaded = spaceChats.filter((chat) => chat.messagesLoaded === false).map((chat) => chat.id);
    if (!q || !unloaded.length) { dbMatches = {}; return; }
    let current = true;
    const timer = setTimeout(() => {
      void searchChatsInDb(q, unloaded).then((hits) => {
        if (current) dbMatches = Object.fromEntries(hits.map((hit) => [hit.chatId, { messageId: hit.messageId, content: hit.content }]));
      });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  });

  const results = $derived.by((): SearchHit[] => {
    const q = query.trim().toLowerCase();
    const hits: SearchHit[] = [];
    for (const chat of spaceChats) {
      if (!q) {
        hits.push({ chat, matchMessageId: null, snippet: null });
        continue;
      }
      const titleHit = (chat.title || '').toLowerCase().includes(q);
      const stored = chat.messagesLoaded === false ? dbMatches[chat.id] : undefined;
      const msg = stored ? { id: stored.messageId, content: stored.content } : chat.messages.find((m) => (m.content || '').toLowerCase().includes(q));
      if (!titleHit && !msg) continue;
      let snippet: string | null = null;
      if (msg) {
        const at = msg.content.toLowerCase().indexOf(q);
        const start = Math.max(0, at - 40);
        const end = at + q.length + 80;
        snippet = (start > 0 ? '…' : '') + msg.content.slice(start, end).replace(/\s+/g, ' ').trim() + (end < msg.content.length ? '…' : '');
      }
      hits.push({ chat, matchMessageId: msg?.id ?? null, snippet });
    }
    return hits.sort((a, b) => (b.chat.updatedAt || b.chat.createdAt) - (a.chat.updatedAt || a.chat.createdAt));
  });

  $effect(() => {
    query;
    selectedIndex = 0;
  });
  $effect(() => {
    if (selectedIndex >= results.length) selectedIndex = results.length - 1;
  });

  /** Active conversation shown in the right-hand live preview pane. */
  const activeHit = $derived(selectedIndex >= 0 ? (results[selectedIndex] ?? null) : null);

  let loadedCache = $state<Record<string, PreviewMessage[]>>({});
  let loadingPreviewId = $state<string | null>(null);

  $effect(() => {
    if (!previewEnabled || !activeHit) return;
    const chat = activeHit.chat;
    if (chat.messagesLoaded !== false || loadedCache[chat.id]) return;
    let alive = true;
    loadingPreviewId = chat.id;
    void loadChatMessagesFromDb(chat.id)
      .then((msgs) => {
        if (!alive) return;
        loadedCache = { ...loadedCache, [chat.id]: msgs };
      })
      .finally(() => {
        if (alive && loadingPreviewId === chat.id) loadingPreviewId = null;
      });
    return () => { alive = false; };
  });

  const previewMessages = $derived.by((): PreviewMessage[] => {
    if (!activeHit) return [];
    const raw = activeHit.chat.messagesLoaded === false
      ? (loadedCache[activeHit.chat.id] ?? [])
      : (activeHit.chat.messages ?? []);
    return raw.filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content || '').trim().length > 0);
  });

  // Reset preview scroll to top (or matching message) when hovering a new chat.
  $effect(() => {
    const id = activeHit?.chat.id;
    const matchId = activeHit?.matchMessageId;
    if (!id || !previewEnabled) return;
    void tick().then(() => {
      if (!previewScroll) return;
      if (matchId) {
        const el = previewScroll.querySelector<HTMLElement>(`[data-preview-msg="${matchId}"]`);
        if (el) { el.scrollIntoView({ block: 'center' }); return; }
      }
      previewScroll.scrollTop = 0;
    });
  });

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

  function close() {
    appStore.chatSearchOpen = false;
  }

  function createChat() {
    close();
    if (appStore.activeSpace === 'code') {
      if (codeProject) codeStore.newConversation(codeProject);
      else void codeStore.addProject();
    } else {
      appStore.createChat(appStore.activeSpace);
    }
  }

  function open(hit: SearchHit) {
    close();
    appStore.selectChat(hit.chat.id);
    if (!hit.matchMessageId) return;
    const messageId = hit.matchMessageId;
    setTimeout(() => window.dispatchEvent(new CustomEvent('scroll-to-chat-message', { detail: { messageId } })), 450);
  }

  function move(step: number) {
    selectedIndex = Math.max(-1, Math.min(results.length - 1, selectedIndex + step));
    void tick().then(() => list?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (selectedIndex < 0) createChat();
      else if (results[selectedIndex]) open(results[selectedIndex]);
    }
  }

  onMount(() => searchInput?.focus());
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="ui-modal-backdrop search-backdrop"
  use:modalLayer={{ onclose: close }}
  onclick={close}
  in:backdropIn
  out:backdropOut
>
  <div
    class="ui-modal-surface search-dialog"
    class:has-preview={previewEnabled}
    role="dialog"
    aria-modal="true"
    aria-label={$t('shortcuts.search')}
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    in:flyAndScale={{ y: -10, start: 0.97, duration: 200 }}
    out:dialogOut
  >
    <div class="search-field">
      <Search class="size-4 shrink-0 text-muted-foreground" />
      <UiInput
        variant="inline"
        class={uiClass('search-input', 'ui-local-63f6f05b')}
        bind:ref={searchInput}
        bind:value={query}
        type="text"
        placeholder={appStore.activeSpace === 'code' ? $t('search.placeholderCode') : $t('search.placeholderChats')}
        aria-label={$t('shortcuts.search')}
        aria-controls="search-results"
        onkeydown={onKeydown}
      />
      <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{countOf(results.length, 'conversation')}</span>
      <button
        type="button"
        class="preview-toggle"
        class:is-on={previewEnabled}
        aria-pressed={previewEnabled}
        onclick={togglePreview}
        title={previewEnabled ? 'Simple view' : 'Preview view'}
      >
        <PanelRight class="size-3.5" />
        <span>Preview</span>
      </button>
    </div>

    <div class="search-body">
      <div bind:this={list} id="search-results" class="search-list" role="listbox" aria-label={$t('shortcuts.search')}>
        <UiListRow
          type="button"
          class={uiClass('ui-row', 'ui-local-63f6f05b', { 'is-highlighted': selectedIndex === -1 })}
          data-selected={selectedIndex === -1}
          role="option"
          aria-selected={selectedIndex === -1}
          onmouseenter={() => (selectedIndex = -1)}
          onclick={createChat}
        >
          <Plus />
          <span class="min-w-0 flex-1 truncate">{newRowLabel}</span>
        </UiListRow>

        {#if results.length}
          <p class="ui-menu-label">{query.trim() ? $t('search.matches') : $t('search.recent')}</p>
          {#each results as hit, index (hit.chat.id)}
            <UiListRow
              type="button"
              class={uiClass('ui-row search-hit', 'ui-local-63f6f05b', { 'is-highlighted': selectedIndex === index })}
              data-selected={selectedIndex === index}
              role="option"
              aria-selected={selectedIndex === index}
              onmouseenter={() => (selectedIndex = index)}
              onclick={() => open(hit)}
            >
              <MessageSquare />
              <span class="min-w-0 flex-1">
                <span class="block truncate">{displayChatTitle(hit.chat)}</span>
                {#if hit.snippet}<span class="block truncate text-xs text-muted-foreground">{hit.snippet}</span>{/if}
              </span>
              <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeDate(hit.chat.updatedAt || hit.chat.createdAt)}</span>
            </UiListRow>
          {/each}
        {:else}
          <EmptyState size="compact" title={query ? $t('search.noMatches') : $t('search.empty')} description={query ? $t('search.noMatchesHint') : $t('search.emptyHint')} />
        {/if}
      </div>

      {#if previewEnabled}
        <aside class="search-preview" aria-label="Conversation preview">
          {#if activeHit}
            <header class="preview-head">
              <div class="min-w-0 flex-1">
                <p class="preview-title">{displayChatTitle(activeHit.chat)}</p>
                <p class="preview-meta">
                  {relativeDate(activeHit.chat.updatedAt || activeHit.chat.createdAt)}
                  {#if previewMessages.length} · {countOf(previewMessages.length, 'message')}{/if}
                </p>
              </div>
              <UiButton size="xs" variant="secondary" onclick={() => open(activeHit)}>
                {$t('search.keysOpen')}
              </UiButton>
            </header>

            <div bind:this={previewScroll} class="preview-scroll">
              {#if loadingPreviewId === activeHit.chat.id}
                <p class="preview-empty">Loading conversation…</p>
              {:else if previewMessages.length}
                {#each previewMessages as msg (msg.id)}
                  <div
                    class="preview-turn"
                    class:is-user={msg.role === 'user'}
                    class:is-match={activeHit.matchMessageId === msg.id}
                    data-preview-msg={msg.id}
                  >
                    {#if msg.role === 'user'}
                      <div class="preview-user-bubble">{msg.content}</div>
                    {:else}
                      <div class="preview-assistant markdown-body">{@html renderMarkdown(msg.content)}</div>
                    {/if}
                  </div>
                {/each}
              {:else}
                <p class="preview-empty">{$t('search.empty')}</p>
              {/if}
            </div>
          {:else}
            <div class="preview-placeholder">
              <p class="preview-empty">{newRowLabel}</p>
            </div>
          {/if}
        </aside>
      {/if}
    </div>

    <footer class="search-footer">
      <span><kbd>↑</kbd><kbd>↓</kbd> {$t('search.keysMove')}</span>
      <span><kbd>Enter</kbd> {$t('search.keysOpen')}</span>
      <span><kbd>Esc</kbd> {$t('search.keysClose')}</span>
    </footer>
  </div>
</div>

<style>
  .search-backdrop {
    align-items: flex-start;
    padding-top: 10vh;
  }

  .search-dialog {
    display: flex;
    width: 100%;
    max-width: 38rem;
    max-height: min(34rem, 78vh);
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    outline: none;
    transition: max-width var(--motion-smooth) var(--motion-ease-out);
  }

  .search-dialog.has-preview {
    max-width: min(60rem, calc(100vw - 2rem));
    height: min(38rem, 80vh);
    max-height: min(38rem, 80vh);
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .search-field :global(input.ui-local-63f6f05b) {
    min-width: 0;
    flex: 1;
    height: 1.75rem;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--foreground);
    font-size: var(--text-base);
    outline: none;
  }

  .search-field :global(input.ui-local-63f6f05b:focus-visible) {
    background: transparent;
  }

  .search-field :global(input.ui-local-63f6f05b::placeholder) {
    color: var(--muted-foreground);
  }

  .preview-toggle {
    display: inline-flex;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease), transform var(--motion-instant) var(--motion-ease);
  }

  .preview-toggle:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .preview-toggle:active {
    transform: translateY(1px);
  }

  .preview-toggle.is-on {
    border-color: var(--float-border);
    background: var(--composer-control-bg);
    box-shadow: var(--control-shadow);
    color: var(--foreground);
  }

  .search-body {
    display: flex;
    min-height: 0;
    flex: 1;
  }

  .search-list {
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: var(--float-pad);
  }

  .search-dialog.has-preview .search-list {
    flex: 0 0 21rem;
    border-right: 1px solid var(--border-subtle);
  }

  :global(.search-hit.ui-local-63f6f05b) {
    min-height: 2.5rem;
  }

  .search-preview {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    background: color-mix(in srgb, var(--foreground) 1.5%, var(--background));
  }

  .preview-head {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .preview-title {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .preview-meta {
    margin: 0.125rem 0 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .preview-scroll {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.875rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 1rem 1.125rem;
  }

  .preview-turn {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .preview-turn.is-user {
    align-items: flex-end;
  }

  .preview-turn.is-match {
    border-radius: var(--radius-md);
    outline: 1px solid color-mix(in srgb, var(--brand-accent) 45%, transparent);
    outline-offset: 4px;
  }

  .preview-user-bubble {
    max-width: 85%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--float-border);
    border-radius: 0.75rem 0.75rem 0.25rem 0.75rem;
    background: var(--user-bubble);
    color: var(--user-bubble-text);
    font-size: var(--text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .preview-assistant {
    max-width: 100%;
    color: var(--prose-ink, var(--foreground));
    font-size: var(--text-sm);
    line-height: 1.6;
  }

  .preview-placeholder {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .preview-empty {
    margin: 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    text-align: center;
  }

  .search-footer {
    display: flex;
    flex-shrink: 0;
    gap: 1rem;
    padding: 0.5rem 0.875rem;
    border-top: 1px solid var(--border-subtle);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  kbd {
    display: inline-flex;
    min-width: 1.25rem;
    justify-content: center;
    margin-right: 0.15rem;
    padding: 0.05rem 0.3rem;
    border: 1px solid var(--float-border);
    border-radius: 0.3125rem;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    box-shadow: 0 1px 0 var(--float-border), inset 0 1px 0 rgb(255 255 255 / 0.08);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    font-size: 0.6875rem;
  }

  @media (max-width: 720px) {
    .search-preview { display: none; }
    .search-dialog.has-preview { max-width: 38rem; height: auto; }
    .search-dialog.has-preview .search-list { flex: 1; border-right: 0; }
  }
</style>
