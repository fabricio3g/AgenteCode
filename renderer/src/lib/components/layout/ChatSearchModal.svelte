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
  class="aui-modal-backdrop z-[250] items-start pt-[15vh]"
  onclick={close}
  onkeydown={handleKeydown}
>
  <div
    class="aui-menu w-full max-w-md overflow-hidden !p-0"
    role="dialog"
    aria-modal="true"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="flex items-center gap-2.5 px-3.5 py-2.5">
      <Search class="size-4 shrink-0 text-muted-foreground" />
      <input
        bind:this={searchInput}
        bind:value={query}
        class="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="Search conversations..."
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
    </div>

    <div bind:this={resultsContainer} class="max-h-[50vh] overflow-y-auto p-1.5">
      {#if results.length === 0}
        <div class="flex flex-col items-center justify-center py-8 text-center">
          <div class="mb-2 flex size-10 items-center justify-center rounded-md bg-muted">
            <MessageSquare class="size-5 text-muted-foreground" />
          </div>
          <p class="text-sm text-muted-foreground">
            {query ? 'No matching conversations' : 'No conversations yet'}
          </p>
        </div>
      {:else}
        {#each results as chat, i (chat.id)}
          <button
            type="button"
            class="aui-menu-item {i === selectedIndex || appStore.currentChatId === chat.id ? 'is-active' : ''}"
            data-selected={i === selectedIndex}
            onclick={() => selectChat(chat.id)}
            onmouseenter={() => (selectedIndex = i)}
          >
            <MessageSquare class="size-4 shrink-0 opacity-70" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{chat.title || 'New chat'}</p>
              <p class="truncate text-xs opacity-70">
                {chat.messages.length} message{chat.messages.length === 1 ? '' : 's'} · {relativeDate(chat.updatedAt || chat.createdAt)}
              </p>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>
