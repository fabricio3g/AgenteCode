<svelte:options runes={true} />

<!--
  One conversation row, shared by every space's sidebar list.

  Select on click; rename inline (double-click or the menu); the "…" menu and
  a right-click open the same Rename / Export / Delete menu. A status dot shows
  a run in progress or a paused run waiting for approval. Home, Roleplay and
  Code used to each hand-roll this, and Code had no menu at all.
-->

<script lang="ts">
  import type { ComponentType } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import { tick } from 'svelte';
  import { FileDown, MoreHorizontal, Pencil, Trash2 } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import type { ChatSession } from '$lib/types/chat';
  import { downloadSessionMarkdown, sessionExportFilename } from './export-session';
  import { displayChatTitle } from './session-title';

  interface Props {
    chat: ChatSession;
    active: boolean;
    onselect: () => void;
    /** Leading icon (Code shows a speech bubble; Home shows none). */
    icon?: ComponentType<LucideIcon>;
    status?: 'running' | 'approval' | null;
    statusLabel?: string;
    menuLabel?: string;
  }

  let { chat, active, onselect, icon: Icon, status = null, statusLabel = '', menuLabel = copy.actions.more }: Props = $props();

  const title = $derived(displayChatTitle(chat));

  let renaming = $state(false);
  let renameValue = $state('');
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let menuOpen = $state(false);
  let anchorPoint = $state<{ x: number; y: number } | null>(null);

  async function startRename() {
    renameValue = title;
    renaming = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function commitRename() {
    const next = renameValue.trim();
    if (renaming && next && next !== title) appStore.renameChat(chat.id, next);
    renaming = false;
  }

  function exportChat() {
    try {
      downloadSessionMarkdown(chat);
      toastStore.success(`${copy.actions.export}: ${sessionExportFilename(chat.title, new Date().toISOString().slice(0, 10))}`, 2500);
    } catch {
      toastStore.error(`${copy.actions.export}: ${copy.tool.failed}`);
    }
  }

  function confirmDelete() {
    confirmStore.show({
      title: copy.confirm.deleteChat.title,
      message: `“${title}” — ${copy.confirm.deleteChat.message}`,
      confirmLabel: copy.actions.delete,
      danger: true,
      onConfirm: () => appStore.deleteChat(chat.id)
    });
  }

  function openContextMenu(event: MouseEvent) {
    event.preventDefault();
    anchorPoint = { x: event.clientX, y: event.clientY };
    menuOpen = true;
  }
</script>

<div
  class="session-row group relative flex w-full cursor-pointer items-center gap-2 px-2.5 py-[5px] text-left"
  class:is-active={active}
  role="button"
  tabindex="0"
  onclick={() => !renaming && onselect()}
  ondblclick={() => void startRename()}
  oncontextmenu={openContextMenu}
  onkeydown={(event) => {
    if (renaming) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onselect();
    } else if (event.key === 'F2') {
      event.preventDefault();
      void startRename();
    }
  }}
>
  {#if Icon}<Icon class="size-3.5 shrink-0" />{/if}
  <div class="min-w-0 flex-1">
    {#if renaming}
      <input
        bind:this={inputEl}
        class="session-rename w-full"
        bind:value={renameValue}
        maxlength="120"
        aria-label={copy.actions.rename}
        onclick={(event) => event.stopPropagation()}
        onkeydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRename();
          } else if (event.key === 'Escape') {
            // Handled here: the sidebar must not treat it as "close dialog".
            event.preventDefault();
            renaming = false;
          }
        }}
        onblur={commitRename}
      />
    {:else}
      <div class="truncate text-[14px]">{title}</div>
    {/if}
  </div>

  {#if status && !renaming}
    <span
      class="status-dot shrink-0"
      class:approval={status === 'approval'}
      title={statusLabel}
      aria-label={statusLabel}
      role="status"
    ></span>
  {/if}

  {#if !renaming}
    <Menu bind:open={menuOpen} bind:anchorPoint placement="bottom-end" label={menuLabel}>
      {#snippet trigger(props)}
        <button
          type="button"
          class="row-menu-btn rounded-[var(--radius-sm)] p-1"
          class:is-open={menuOpen}
          aria-label={menuLabel}
          {...props}
        >
          <MoreHorizontal class="size-3.5" />
        </button>
      {/snippet}
      <MenuItem icon={Pencil} label={copy.actions.rename} onselect={() => void startRename()} />
      <MenuItem icon={FileDown} label={copy.actions.export} onselect={exportChat} />
      <MenuItem icon={Trash2} label={copy.actions.delete} danger onselect={confirmDelete} />
    </Menu>
  {/if}
</div>

<style>
  .session-row {
    color: var(--muted-foreground);
    border-radius: var(--radius-full);
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .session-row:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .session-row.is-active {
    background: var(--sidebar-accent);
    color: var(--foreground);
  }

  .session-row:focus-visible {
    outline: 2px solid var(--sidebar-ring);
    outline-offset: -2px;
  }

  .session-rename {
    background: var(--background);
    border: 1px solid var(--sidebar-ring);
    border-radius: var(--radius-sm);
    color: var(--foreground);
    font-size: 14px;
    padding: 0 0.35rem;
    outline: none;
  }

  /* Revealed on hover or keyboard focus, never invisible to keyboard users. */
  .row-menu-btn {
    color: inherit;
    background: transparent;
    border: none;
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .session-row:hover .row-menu-btn,
  .session-row:focus-within .row-menu-btn,
  .row-menu-btn.is-open,
  .row-menu-btn:focus-visible {
    opacity: 0.75;
  }

  .row-menu-btn:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--sidebar-foreground) 10%, transparent);
  }

  .status-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 9999px;
    background: var(--muted-foreground);
    animation: session-pulse 1.2s ease-in-out infinite;
  }

  .status-dot.approval {
    background: var(--warning, #d97706);
    animation: none;
  }

  @keyframes session-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-dot { animation: none; }
  }
</style>
