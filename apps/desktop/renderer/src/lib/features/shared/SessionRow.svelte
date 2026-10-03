<svelte:options runes={true} />

<!--
  One conversation row, shared by every space's sidebar list.

  Select on click; rename inline (double-click or the menu); the "…" menu and
  a right-click open the same Rename / Export / Delete menu. A status dot shows
  a run in progress or a paused run waiting for approval.

  Home, Roleplay and Code used to each hand-roll this, and Code had no menu at
  all. The row itself, its rename input and its status dot now come from the
  shared rail recipe (app.css `.sidebar-row`, `.chat-rename-input`, StatusDot),
  so this component carries no scoped CSS.
-->

<script lang="ts">
  import type { ComponentType } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import { tick } from 'svelte';
  import { FileDown, MoreHorizontal, Pencil, Trash2 } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
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
  class="sidebar-row group relative"
  class:is-current={active}
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

  {#if renaming}
    <input
      bind:this={inputEl}
      class="chat-rename-input sidebar-row-label"
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
    <div class="sidebar-row-label">{title}</div>
  {/if}

  {#if status && !renaming}
    <StatusDot
      tone={status === 'approval' ? 'approval' : 'running'}
      label={statusLabel}
    />
  {/if}

  {#if !renaming}
    <Menu bind:open={menuOpen} bind:anchorPoint placement="bottom-end" label={menuLabel}>
      {#snippet trigger(props)}
        <IconButton
          {...props}
          class="sidebar-row-action{menuOpen ? ' is-open' : ''}"
          label={menuLabel}
        >
          <MoreHorizontal />
        </IconButton>
      {/snippet}
      <MenuItem icon={Pencil} label={copy.actions.rename} onselect={() => void startRename()} />
      <MenuItem icon={FileDown} label={copy.actions.export} onselect={exportChat} />
      <MenuItem icon={Trash2} label={copy.actions.delete} danger onselect={confirmDelete} />
    </Menu>
  {/if}
</div>
