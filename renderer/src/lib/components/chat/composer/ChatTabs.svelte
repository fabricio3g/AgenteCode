<svelte:options runes={true} />

<script lang="ts">
  import { ArrowUp, MoreHorizontal, Pencil, Trash2, FileDown } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';

  let scroller: HTMLDivElement | undefined = $state();
  let openMenuId = $state<string | null>(null);
  let menuPosition = $state({ top: 0, left: 0 });
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);
  let width = $state(0);

  const compact = $derived(width > 0 && width < 640);
  const recentChats = $derived.by(() => {
    const chats = [...appStore.chats].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    return chats.slice(0, compact ? 4 : 6);
  });

  function updateScrollState() {
    if (!scroller) {
      canScrollLeft = false;
      canScrollRight = false;
      return;
    }
    canScrollLeft = scroller.scrollLeft > 8;
    canScrollRight = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 8;
  }

  function scroll(direction: 'left' | 'right') {
    if (!scroller) return;
    const amount = Math.max(180, Math.round(scroller.clientWidth * 0.7));
    scroller.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
    requestAnimationFrame(updateScrollState);
  }

  function getLabel(title: string) {
    return title.trim() || 'New chat';
  }

  function toggleMenu(event: MouseEvent, chatId: string) {
    event.stopPropagation();
    if (openMenuId === chatId) {
      openMenuId = null;
      return;
    }
    const button = event.currentTarget as HTMLElement;
    const rect = button.getBoundingClientRect();
    const menuWidth = 160;
    const viewportPadding = 12;
    const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding);
    menuPosition = { top: rect.bottom + 8, left: Math.max(viewportPadding, left) };
    openMenuId = chatId;
  }

  function renameChat(chatId: string, currentTitle: string) {
    const nextTitle = window.prompt('Rename chat', currentTitle)?.trim();
    if (!nextTitle) {
      openMenuId = null;
      return;
    }
    appStore.renameChat(chatId, nextTitle);
    openMenuId = null;
  }

  function deleteChat(chatId: string) {
    confirmStore.show({
      title: 'Delete chat?',
      message: 'This chat and its context will be removed permanently.',
      danger: true,
      confirmLabel: 'Delete',
      onConfirm: () => appStore.deleteChat(chatId)
    });
    openMenuId = null;
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
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    openMenuId = null;
  }

  $effect(() => {
    if (!openMenuId) return;
    const close = () => { openMenuId = null; };
    const timer = setTimeout(() => {
      document.addEventListener('click', close, { once: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  });

  $effect(() => {
    if (!openMenuId) return;
    const close = () => { openMenuId = null; };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  });

  $effect(() => {
    width;
    recentChats.length;
    updateScrollState();
  });
</script>

{#if appStore.sidebarOpen}
<div bind:clientWidth={width} class="chateaui-card pointer-events-auto relative z-20 mb-3 rounded-xl px-3 py-2">
  {#if canScrollLeft}
    <button
      type="button"
      class="chateaui-pill absolute -left-3 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-[var(--text-secondary)] transition hover:text-[var(--text)]"
      onclick={() => scroll('left')}
      aria-label="Scroll chats left"
    >
      <ArrowUp class="h-3.5 w-3.5 -rotate-90" />
    </button>
  {/if}
  {#if canScrollRight}
    <button
      type="button"
      class="chateaui-pill absolute -right-3 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-[var(--text-secondary)] transition hover:text-[var(--text)]"
      onclick={() => scroll('right')}
      aria-label="Scroll chats right"
    >
      <ArrowUp class="h-3.5 w-3.5 rotate-90" />
    </button>
  {/if}
  <div
    bind:this={scroller}
    class="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [scroll-snap-type:x_proximity] [&::-webkit-scrollbar]:hidden"
    onscroll={updateScrollState}
  >
    {#each recentChats as chat (chat.id)}
      <div class="relative shrink-0 snap-start">
        <div
          class={`flex items-center gap-1 rounded-full border pr-1 transition ${appStore.currentChatId === chat.id ? 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]' : 'border-transparent bg-[var(--surface-hover)] text-[var(--text-tertiary)] hover:border-[var(--border)] hover:bg-[var(--surface)] hover:text-[var(--text)]'}`}
        >
          <button
            type="button"
            class="max-w-[9rem] truncate rounded-full px-3 py-1.5 text-xs font-medium sm:max-w-[10rem]"
            onclick={() => appStore.selectChat(chat.id)}
          >
            {getLabel(chat.title)}
          </button>
            <button
              type="button"
              class="chateaui-icon-button flex h-7 w-7 items-center justify-center rounded-full"
              style="--chateaui-icon-button-color: var(--text-muted);"
              aria-label="Chat options"
              onclick={(event) => toggleMenu(event, chat.id)}
            >
            <MoreHorizontal class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    {/each}

    <button
      type="button"
      class="chateaui-pill shrink-0 snap-start px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:text-[var(--text)]"
      style="--chateaui-pill-border-style: dashed;"
      onclick={() => appStore.createChat()}
    >
      + New
    </button>
  </div>
</div>
{/if}

{#if openMenuId}
  {@const activeChat = recentChats.find((chat) => chat.id === openMenuId)}
  {#if activeChat}
    <div
      class="chateaui-menu pointer-events-auto fixed z-[220] w-40 py-1"
      style={`top: ${menuPosition.top}px; left: ${menuPosition.left}px;`}
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
      role="menu"
      tabindex="-1"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
        onclick={() => renameChat(activeChat.id, activeChat.title)}
      >
        <Pencil class="h-3.5 w-3.5 text-[var(--text-muted)]" />
        Rename
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
        onclick={() => exportChat(activeChat)}
      >
        <FileDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />
        Export
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-error transition hover:bg-error-bg"
        onclick={() => deleteChat(activeChat.id)}
      >
        <Trash2 class="h-3.5 w-3.5" />
        Delete
      </button>
    </div>
  {/if}
{/if}
