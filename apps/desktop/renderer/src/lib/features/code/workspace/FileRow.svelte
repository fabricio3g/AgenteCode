<svelte:options runes={true} />

<!--
  One row of the file tree: chevron and folder for a directory, the working
  tree's change letter for a file, and the row's own actions.

  The actions live in a menu on the trailing "…" (and on right click), not in
  a second row of buttons: the tree is dense, and a file needs its actions at
  the pointer, not at the bottom of the panel.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronDown, ChevronRight, Copy, File as FileIcon, Folder, FolderOpen, MoreHorizontal, PenLine, AtSign } from 'lucide-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { invoke } from '$lib/services/bridge';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { openFileInEditor } from './editor-actions';

  export interface FileEntry {
    path: string;
    name: string;
    dir: boolean;
    depth: number;
    expanded: boolean;
  }

  let {
    entry,
    projectRoot,
    selected = false,
    mark = null,
    onselect,
    ontoggle
  }: {
    entry: FileEntry;
    projectRoot: string;
    selected?: boolean;
    mark?: { letter: string; tone: string } | null;
    onselect: () => void;
    ontoggle: () => void;
  } = $props();

  let menuOpen = $state(false);
  let anchorPoint = $state<{ x: number; y: number } | null>(null);

  function openContextMenu(event: MouseEvent) {
    event.preventDefault();
    onselect();
    anchorPoint = { x: event.clientX, y: event.clientY };
    menuOpen = true;
  }

  function activate() {
    onselect();
    if (entry.dir) ontoggle();
    else void openFileInEditor(projectRoot, entry.path);
  }

  async function reveal() {
    const result = await invoke<{ ok: boolean; error?: string }>('agente_reveal_path', { projectRoot, path: entry.path }).catch(() => null);
    if (!result?.ok) toastStore.error(result?.error || $t('codeWs.revealFailed'));
  }

  async function copyPath() {
    if (await writeToClipboard(entry.path)) toastStore.success($t('codeWs.pathCopied'));
    else toastStore.error($t('codeWs.copyFailed'));
  }

  /** The same `@path` shape the composer's mention inserter writes. */
  function mention() {
    const text = /\s/.test(entry.path) ? `@"${entry.path}" ` : `@${entry.path} `;
    window.dispatchEvent(new CustomEvent('code-composer-append', { detail: { text } }));
    window.dispatchEvent(new Event('focus-composer'));
  }
</script>

<li
  class="file-node"
  class:is-selected={selected}
  role="treeitem"
  aria-selected={selected}
  aria-level={entry.depth + 1}
  aria-expanded={entry.dir ? entry.expanded : undefined}
  data-path={entry.path}
  oncontextmenu={openContextMenu}
>
  <button type="button" class="file-row" title={entry.path} onclick={activate}>
    <span class="file-indent" style="width: {entry.depth * 0.65}rem"></span>
    {#if entry.dir}
      {#if entry.expanded}<ChevronDown class="size-3 shrink-0 opacity-70" aria-hidden="true" />{:else}<ChevronRight class="size-3 shrink-0 opacity-70" aria-hidden="true" />{/if}
      {#if entry.expanded}<FolderOpen class="size-3.5 shrink-0" aria-hidden="true" />{:else}<Folder class="size-3.5 shrink-0" aria-hidden="true" />{/if}
    {:else}
      <FileIcon class="size-3.5 shrink-0" aria-hidden="true" />
    {/if}
    <span class="file-name">{entry.name}</span>
    {#if mark}<span class="file-mark {mark.tone}" aria-hidden="true">{mark.letter}</span>{/if}
  </button>

  <Menu bind:open={menuOpen} bind:anchorPoint placement="bottom-end" minWidth="12rem" label={$t('codeWs.fileActions')}>
    {#snippet trigger(props)}
      <IconButton {...props} class="file-action" label={$t('codeWs.fileActions')}><MoreHorizontal /></IconButton>
    {/snippet}
    {#if entry.dir}
      <MenuItem icon={entry.expanded ? ChevronRight : ChevronDown} label={entry.expanded ? $t('codeWs.collapseFolder') : $t('codeWs.expandFolder')} onselect={ontoggle} />
    {:else}
      <MenuItem icon={PenLine} label={$t('codeWs.openInEditor')} onselect={() => void openFileInEditor(projectRoot, entry.path)} />
    {/if}
    <MenuItem icon={Copy} label={$t('codeWs.copyPath')} onselect={() => void copyPath()} />
    {#if !entry.dir}
      <MenuItem icon={AtSign} label={$t('codeWs.mentionFile')} onselect={mention} />
    {/if}
    <MenuItem icon={FolderOpen} label={$t('codeWs.revealInFolder')} onselect={() => void reveal()} />
  </Menu>
</li>

<style>
  /* One sidebar row's density, one step tighter: a 22px pill, 14px glyphs —
     the same `size-3.5` the sidebar uses — and 12px copy, so the tree reads as
     the sidebar's sibling list rather than as a second, heavier one. */
  .file-node { position: relative; display: flex; height: 1.375rem; align-items: center; }
  .file-row {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 1.375rem;
    align-items: center;
    gap: 0.35rem;
    border-radius: var(--radius-full);
    padding: 0 1.4rem 0 0.45rem;
    font-size: var(--text-xs);
    text-align: left;
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .file-row:hover,
  .file-node.is-selected .file-row { background: var(--surface-hover); }
  .file-indent { flex-shrink: 0; }
  .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); }
  .file-mark { flex-shrink: 0; margin-left: auto; font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; }
  /* The actions replace the change letter on hover rather than stacking on it. */
  .file-node:hover .file-mark,
  .file-node:focus-within .file-mark { opacity: 0; }
  .file-node :global(.file-action) {
    position: absolute;
    top: 50%;
    right: 0.15rem;
    transform: translateY(-50%);
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }
  .file-node:hover :global(.file-action),
  .file-node :global(.file-action[aria-expanded='true']),
  .file-node :global(.file-action:focus-visible) { opacity: 1; }

  @media (prefers-reduced-motion: reduce) {
    .file-row { transition: none; }
    .file-node :global(.file-action) { transition: none; }
  }
</style>
