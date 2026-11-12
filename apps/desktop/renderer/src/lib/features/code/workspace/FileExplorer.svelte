<svelte:options runes={true} />

<!--
  The project's files, as a tree.

  The list comes from the same git-aware walk the composer's `@` mentions use,
  so a file the agent just created is here too and nothing ignored shows up.
  Folders open lazily: the whole tree is built once per list, but only the rows
  the user opened are painted, which keeps a large repository cheap.

  Single click selects, double click (or Enter) acts: a folder opens, a file
  goes to the editor. The row's own menu holds the rest.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';

  import { PaneHeader, Tooltip } from '$lib/components/ui';
  import { t } from 'svelte-i18n';
  import { FolderTree, LoaderCircle, RefreshCw, X } from 'lucide-svelte';
  import { workspaceLayout as defaultLayout, type WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import FileRow, { type FileEntry } from './FileRow.svelte';
  import { buildTree, firstChildPath, parentPath, visibleRows } from './file-tree';
  import { openFileInEditor } from './editor-actions';

  let { chatId, projectRoot, embedded = false, layout: workspaceLayout = defaultLayout }: { layout?: WorkspaceLayoutStore; chatId: string; projectRoot: string; embedded?: boolean } = $props();

  /** Folders the user opened, by project-relative path. */
  let expanded = $state(new Set<string>());
  let selected = $state<string | null>(null);
  let treeEl = $state<HTMLElement>();

  const files = $derived(codeWorkspace.filesFor(projectRoot));
  const loading = $derived(!files && !!codeWorkspace.projectFilesLoading[projectRoot]);
  const tree = $derived(files ? buildTree(files) : []);
  const rows = $derived(visibleRows(tree, expanded));

  /** The working tree's change letter, so the tree and the Changes pane agree. */
  const MARK: Record<string, { letter: string; tone: string }> = {
    created: { letter: 'A', tone: 'text-success' },
    modified: { letter: 'M', tone: 'text-warning' },
    deleted: { letter: 'D', tone: 'text-error' },
    renamed: { letter: 'R', tone: 'text-muted-foreground' }
  };
  const marks = $derived.by(() => {
    const list = codeWorkspace.changesFor(chatId);
    return new Map((list?.files ?? []).map((file) => [file.path, MARK[file.kind] ?? MARK.modified!]));
  });

  const entries = $derived<FileEntry[]>(rows.map((row) => ({ path: row.node.path, name: row.node.name, dir: row.node.dir, depth: row.depth, expanded: row.expanded })));

  // First paint, and again after a branch switch (which invalidates the list).
  $effect(() => {
    if (!files) void codeWorkspace.loadProjectFiles(projectRoot);
  });

  // The changes list refreshes on run boundaries and on window focus; the tree
  // follows it so a file the agent just wrote appears without a manual refresh.
  let seenChanges = $state(-1);
  $effect(() => {
    const count = codeWorkspace.changesFor(chatId)?.files.length ?? 0;
    if (count === seenChanges) return;
    seenChanges = count;
    if (files) void codeWorkspace.loadProjectFiles(projectRoot, true);
  });

  // Keep the selected row in view when the keyboard moves it.
  $effect(() => {
    const path = selected;
    const list = treeEl?.querySelectorAll<HTMLElement>('[data-path]');
    if (!path || !list) return;
    for (const node of list) if (node.dataset.path === path) { node.scrollIntoView({ block: 'nearest' }); break; }
  });

  function toggle(path: string) {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    expanded = next;
  }

  function activate(entry: FileEntry) {
    selected = entry.path;
    if (entry.dir) toggle(entry.path);
    else void openFileInEditor(projectRoot, entry.path);
  }

  function move(delta: number) {
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.node.path === selected);
    const next = Math.max(0, Math.min(rows.length - 1, (index < 0 ? 0 : index) + delta));
    selected = rows[next]?.node.path ?? null;
  }

  function onKeyDown(event: KeyboardEvent) {
    const row = rows.find((item) => item.node.path === selected);
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return; }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (!row) { move(1); return; }
      if (row.node.dir && !row.expanded) toggle(row.node.path);
      else { const child = firstChildPath(row.node); if (child) selected = child; }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!row) return;
      if (row.node.dir && row.expanded) { toggle(row.node.path); return; }
      const parent = parentPath(row.node.path);
      if (parent) selected = parent;
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (!row) return;
      event.preventDefault();
      activate({ path: row.node.path, name: row.node.name, dir: row.node.dir, depth: row.depth, expanded: row.expanded });
    }
  }

  function refresh() {
    void codeWorkspace.loadProjectFiles(projectRoot, true);
  }

  function hide() {
    workspaceLayout.hide('files');
  }
</script>

<aside class="files" aria-label={$t('codeWs.files')}>
  <PaneHeader>
    <p class="min-w-0 flex-1 truncate">
      {#if !embedded}<span class="font-medium text-foreground">{$t('codeWs.files')}</span>{/if}
      {#if files}<span class="ml-1.5 text-muted-foreground">{$t('codeWs.fileCount', { values: { n: files.length } })}</span>{/if}
    </p>
    {#snippet actions()}
    <Tooltip label={$t('codeWs.refresh')} position="bottom"><UiIconButton label={$t('codeWs.refresh')} size="xs" type="button"  onclick={refresh} disabled={loading} >
      <RefreshCw class={loading ? 'animate-spin' : ''} />
    </UiIconButton></Tooltip>
    {#if !embedded}<Tooltip label={$t('codeWs.close')} position="bottom"><UiIconButton label={$t('codeWs.close')} size="xs" type="button"  onclick={hide} ><X /></UiIconButton></Tooltip>{/if}
    {/snippet}
  </PaneHeader>

  {#if loading}
    <div class="flex flex-1 items-center justify-center"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
  {:else if files && !files.length}
    <div class="pane-body"><p class="pane-empty"><FolderTree class="size-3.5" />{$t('codeWs.noFiles')}</p></div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <ul class="files-tree" role="tree" aria-label={$t('codeWs.files')} bind:this={treeEl} tabindex="0" onkeydown={onKeyDown}>
      {#each entries as entry (entry.path)}
        <FileRow
          {entry}
          {projectRoot}
          selected={selected === entry.path}
          mark={marks.get(entry.path) ?? null}
          onselect={() => (selected = entry.path)}
          ontoggle={() => toggle(entry.path)}
        />
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .files { display: flex; min-height: 0; width: 100%; height: 100%; flex: 1; flex-direction: column; background: transparent; }
  /* Rows are 1.375rem tiles: the gap keeps a hovered row from touching the next,
     and the top inset keeps the first one off the bar. */
  .files-tree { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.125rem; padding: 0.25rem 0.75rem 0.75rem; outline: none; }
  .files-tree:focus-visible { outline: 1px solid var(--border-hover); outline-offset: -1px; }
</style>
