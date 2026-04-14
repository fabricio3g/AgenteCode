<svelte:options runes={true} />

<script lang="ts">
  import { Search, X, MessageSquare } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { onMount, tick } from 'svelte';

  let searchInput: HTMLInputElement | undefined = $state();
  let query = $state('');
  let selectedIndex = $state(0);
  let resultsContainer: HTMLDivElement | undefined = $state();

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function relativeDate(ts: number): string {
    const now = startOfDay(Date.now());
    const day = startOfDay(ts);
    const diff = Math.floor((now - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff <= 6) return `${diff}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [...appStore.chats]
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .slice(0, 10);
    }
    return appStore.chats
      .filter(chat =>
        chat.title.toLowerCase().includes(q) ||
        chat.messages.some(m => m.content.toLowerCase().includes(q))
      )
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .slice(0, 20);
  });

  // Reset selection when results change
  $effect(() => {
    results.length;
    selectedIndex = 0;
  });

  function selectChat(id: string) {
    appStore.selectChat(id);
    appStore.chatSearchOpen = false;
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
        selectedIndex = (selectedIndex + 1) % results.length;
        scrollSelectedIntoView();
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        scrollSelectedIntoView();
      }
      return;
    }
    if (event.key === 'Enter') {
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
  class="fixed inset-0 z-[250] flex items-start justify-center bg-overlay px-4 pt-[15vh]"
  onclick={close}
  onkeydown={handleKeydown}
>
  <div
    class="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-xl)] overflow-hidden"
    role="dialog"
    aria-modal="true"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Search input -->
    <div class="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
      <Search class="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      <input
        bind:this={searchInput}
        bind:value={query}
        class="flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        placeholder="Search conversations..."
        type="text"
      />
      {#if query}
        <button
          type="button"
          class="rounded-md p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
          onclick={() => (query = '')}
          aria-label="Clear"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      {/if}
    </div>

    <!-- Results -->
    <div bind:this={resultsContainer} class="max-h-[50vh] overflow-y-auto p-2">
      {#if results.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center">
          <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--surface-highlight)] border border-[var(--border-light)]">
            <MessageSquare class="h-5 w-5 text-[var(--text-muted)]" />
          </div>
          <p class="text-sm text-[var(--text-muted)]">
            {query ? 'No matching conversations' : 'No conversations yet'}
          </p>
        </div>
      {:else}
        {#each results as chat, i (chat.id)}
          <button
            type="button"
            class="chat-result flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition border border-transparent"
            class:is-selected={i === selectedIndex}
            class:is-active={appStore.currentChatId === chat.id}
            data-selected={i === selectedIndex}
            onclick={() => selectChat(chat.id)}
            onmouseenter={() => (selectedIndex = i)}
          >
            <MessageSquare class="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-[var(--text)]">{chat.title || 'New chat'}</p>
              <p class="truncate text-xs text-[var(--text-muted)]">
                {chat.messages.length} message{chat.messages.length === 1 ? '' : 's'} · {relativeDate(chat.updatedAt || chat.createdAt)}
              </p>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .chat-result {
    color: var(--text-secondary);
  }

  .chat-result:hover,
  .chat-result.is-selected {
    background: var(--surface-highlight);
    border-color: var(--border-light);
  }

  .chat-result.is-active {
    background: var(--surface-secondary);
    border-color: var(--border);
  }
</style>
