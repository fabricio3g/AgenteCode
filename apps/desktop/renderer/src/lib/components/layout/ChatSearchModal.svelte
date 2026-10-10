<svelte:options runes={true} />

<!--
  Search conversations: a command palette, not a second app. One field, a
  "new conversation" row, then the matches — title, where the query matched,
  and when. Arrows move, Enter opens, Escape or a click outside closes.

  It used to carry a live preview pane and per-row rename/delete buttons; the
  sidebar already owns those, and the extra surface made the dialog read as a
  different program.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { MessageSquare, Plus, Search } from 'lucide-svelte';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { displayChatTitle } from '$lib/features/shared/session-title';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { countOf } from '$lib/utils/format';
  import type { ChatSession } from '$lib/types/chat';

  let searchInput = $state<HTMLInputElement>();
  let list = $state<HTMLDivElement>();
  let query = $state('');
  /** -1 is the "new conversation" row; 0.. are results. */
  let selectedIndex = $state(0);

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
  const spaceChats = $derived(appStore.botsOpen ? [] : appStore.getSessionsForSpace(appStore.activeSpace));

  interface SearchHit {
    chat: ChatSession;
    /** First message containing the query — where opening it scrolls to. */
    matchMessageId: string | null;
    snippet: string | null;
  }

  const results = $derived.by((): SearchHit[] => {
    const q = query.trim().toLowerCase();
    const hits: SearchHit[] = [];
    for (const chat of spaceChats) {
      if (!q) {
        hits.push({ chat, matchMessageId: null, snippet: null });
        continue;
      }
      const titleHit = (chat.title || '').toLowerCase().includes(q);
      const msg = chat.messages.find((m) => (m.content || '').toLowerCase().includes(q));
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

  // A new query starts at the first match. Keyed on the query alone: a running
  // agent updates its chat constantly, and keying on results reset the highlight.
  $effect(() => {
    query;
    selectedIndex = 0;
  });
  $effect(() => {
    if (selectedIndex >= results.length) selectedIndex = results.length - 1;
  });

  // In Code a conversation lives in a project: start one in the active
  // project, or add a project when there is none.
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
    // The thread registers its messages after it renders; then it scrolls the match into view.
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
<div class="ui-modal-backdrop search-backdrop" use:modalLayer={{ onclose: close }} onclick={close}>
  <div
    class="search-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={$t('shortcuts.search')}
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="search-field">
      <Search class="size-4 shrink-0 text-muted-foreground" />
      <UiInput class={uiClass('', "ui-local-63f6f05b")}
        bind:ref={searchInput}
        bind:value={query}
        type="text"
        placeholder={appStore.activeSpace === 'code' ? $t('search.placeholderCode') : $t('search.placeholderChats')}
        aria-label={$t('shortcuts.search')}
        aria-controls="search-results"
        onkeydown={onKeydown}
      />
      <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{countOf(results.length, 'conversation')}</span>
    </div>

    <div bind:this={list} id="search-results" class="search-list" role="listbox" aria-label={$t('shortcuts.search')}>
      <UiListRow
        type="button"
        class={uiClass("ui-row", "ui-local-63f6f05b", {"is-highlighted": selectedIndex === -1})}

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
            class={uiClass("ui-row search-hit", "ui-local-63f6f05b", {"is-highlighted": selectedIndex === index})}

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
            <span class="shrink-0 text-xs text-muted-foreground">{relativeDate(hit.chat.updatedAt || hit.chat.createdAt)}</span>
          </UiListRow>
        {/each}
      {:else}
        <div class="search-empty">
          <p class="text-[13px] font-medium text-foreground">{query ? $t('search.noMatches') : $t('search.empty')}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{query ? $t('search.noMatchesHint') : $t('search.emptyHint')}</p>
        </div>
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
    padding-top: 12vh;
  }

  .search-dialog {
    display: flex;
    width: 100%;
    max-width: 38rem;
    max-height: min(32rem, 76vh);
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    outline: none;
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .search-field :global(input.ui-local-63f6f05b) {
    min-width: 0;
    flex: 1;
    border: 0;
    background: transparent;
    color: var(--foreground);
    font-size: var(--text-base);
    outline: none;
  }

  .search-field :global(input.ui-local-63f6f05b::placeholder) { color: var(--muted-foreground); }

  .search-list {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: var(--float-pad);
  }

  :global(.search-hit.ui-local-63f6f05b) { min-height: 2.5rem; }

  .search-empty {
    padding: 1.5rem 1rem;
    text-align: center;
  }

  .search-footer {
    display: flex;
    gap: 1rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--border-subtle);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  kbd {
    display: inline-flex;
    min-width: 1.25rem;
    justify-content: center;
    margin-right: 0.125rem;
    padding: 0 0.25rem;
    border: 1px solid var(--float-border);
    border-radius: 0.25rem;
    font-family: inherit;
    font-size: 0.6875rem;
  }
</style>
