<svelte:options runes={true} />

<!--
  Changes: every file that differs from its "before" (git HEAD in a
  repository, the agent's first snapshot otherwise), with a unified diff of
  the selected file and a per-file revert.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { FileCode2, FolderOpen, LoaderCircle, RefreshCw, Undo2, X } from 'lucide-svelte';
  import { invoke } from '$lib/services/bridge';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import { parsePatch } from '../patch';
  import DiffRows from '../DiffRows.svelte';
  import DiffView from './DiffView.svelte';
  import type { ChangeKind, FileDiff } from '$shared/code-workspace';

  let { chatId, projectRoot, sessionId }: { chatId: string; projectRoot: string; sessionId?: string } = $props();

  /** A listed file: from git, or only from the transcript's own record of an edit. */
  type Entry = { path: string; kind: ChangeKind; additions: number; deletions: number; patches?: string[] };

  const args = $derived({ chatId, projectRoot, ...(sessionId ? { sessionId } : {}) });
  const list = $derived(codeWorkspace.changes);
  const root = $derived(projectRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/'));

  /** An edit's path relative to the project when it lies inside it. */
  function relative(path: string): string {
    const normal = path.replace(/\\/g, '/');
    return normal.startsWith(`${root}/`) ? normal.slice(root.length + 1) : normal;
  }

  function samePath(a: string, b: string): boolean {
    return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  }

  // Git sees every change on disk; edits it can't show (no repository, or
  // already committed) still open from what the transcript recorded.
  const files = $derived.by((): Entry[] => {
    const fromGit: Entry[] = list?.files ?? [];
    const recorded = (codeWorkspace.transcriptEdits[chatId] ?? [])
      .filter((edit) => edit.patches.length && !fromGit.some((file) => samePath(file.path, relative(edit.path))))
      .map((edit) => ({ path: relative(edit.path), kind: edit.kind, additions: edit.additions, deletions: edit.deletions, patches: edit.patches }) satisfies Entry);
    return [...fromGit, ...recorded];
  });
  const totals = $derived(files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 }));

  let selectedPath = $state<string | null>(null);
  const selected = $derived(files.find((f) => f.path === selectedPath) ?? null);
  let diff = $state<FileDiff | null>(null);
  let diffLoading = $state(false);

  function refresh() {
    void codeWorkspace.refreshChanges(args);
  }

  // "View changes" from the transcript picks its file once it is listed.
  $effect(() => {
    const wanted = codeWorkspace.focusPath;
    if (!wanted) return;
    const match = files.find((f) => samePath(f.path, relative(wanted)));
    if (match) {
      selectedPath = match.path;
      codeWorkspace.focusPath = null;
    }
  });

  // Keep the selection valid as the list changes.
  $effect(() => {
    if (selectedPath && !files.some((f) => f.path === selectedPath)) selectedPath = null;
    if (!selectedPath && files.length) selectedPath = files[0].path;
  });

  $effect(() => {
    const path = selectedPath;
    void list;
    if (!path || selected?.patches) {
      diff = null;
      return;
    }
    diffLoading = true;
    void codeWorkspace.fileDiff({ ...args, path })
      .then((result) => { if (selectedPath === path) diff = result; })
      .catch(() => { if (selectedPath === path) diff = null; })
      .finally(() => { if (selectedPath === path) diffLoading = false; });
  });

  function split(path: string): { name: string; dir: string } {
    const index = path.lastIndexOf('/');
    return index < 0 ? { name: path, dir: '' } : { name: path.slice(index + 1), dir: path.slice(0, index) };
  }

  const KIND_MARK: Record<ChangeKind, { letter: string; tone: string }> = {
    created: { letter: 'A', tone: 'text-success' },
    modified: { letter: 'M', tone: 'text-warning' },
    deleted: { letter: 'D', tone: 'text-error' },
    renamed: { letter: 'R', tone: 'text-muted-foreground' }
  };

  async function revert(file: Entry) {
    const accepted = await confirmStore.ask({
      title: $t('codeWs.revertTitle', { values: { name: split(file.path).name } }),
      message: list?.source === 'git' ? $t('codeWs.revertGit') : $t('codeWs.revertSnapshot'),
      details: [file.path],
      confirmLabel: $t('codeWs.revert'),
      danger: true
    });
    if (!accepted) return;
    const result = await codeWorkspace.revertFile({ ...args, path: file.path });
    if (result.ok) toastStore.success($t('codeWs.reverted', { values: { name: split(file.path).name } }));
    else toastStore.error(result.error || $t('codeWs.revertFailed'));
    refresh();
  }

  function openFile(path: string) {
    const absolutePath = path.startsWith('/') || /^[a-z]:/i.test(path) ? path : `${root}/${path}`;
    void invoke('open_workspace_file', { absolutePath, workspaceRoot: projectRoot }).catch(() => {});
  }
</script>

<aside class="changes" aria-label={$t('codeWs.changes')}>
  <!-- The same slim bar as the browser panel's. -->
  <header class="changes-bar">
    <p class="min-w-0 flex-1 truncate">
      <span class="font-medium text-foreground">{$t('codeWs.changes')}</span>
      {#if files.length}
        <span class="ml-1.5 text-muted-foreground">{$t('codeWs.fileCount', { values: { n: files.length } })}</span>
        <span class="ml-1 tabular-nums"><span class="text-success">+{totals.add}</span> <span class="text-error">−{totals.del}</span></span>
      {/if}
    </p>
    <button type="button" class="ui-icon-button is-sm" onclick={refresh} disabled={codeWorkspace.changesLoading} aria-label={$t('codeWs.refresh')} title={$t('codeWs.refresh')}>
      <RefreshCw class={codeWorkspace.changesLoading ? 'animate-spin' : ''} />
    </button>
    <button type="button" class="ui-icon-button is-sm" onclick={() => codeWorkspace.toggleChanges(false)} aria-label={$t('codeWs.close')} title={$t('codeWs.close')}><X /></button>
  </header>

  {#if !list && codeWorkspace.changesLoading}
    <div class="flex flex-1 items-center justify-center"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
  {:else if !files.length}
    <!-- Empty: a quiet note at the top, not a poster in the middle. -->
    <div class="changes-empty">
      <FileCode2 class="mt-0.5 size-3.5 shrink-0" />
      <div class="min-w-0">
        <p class="text-foreground">{$t('codeWs.noChanges')}</p>
        <p>{list?.source === 'git' ? $t('codeWs.noChangesGit') : $t('codeWs.noChangesHint')}</p>
      </div>
    </div>
  {:else}
    <ul class="changes-list" role="listbox" aria-label={$t('codeWs.changes')}>
      {#each files as file (file.path)}
        {@const parts = split(file.path)}
        {@const mark = KIND_MARK[file.kind] ?? KIND_MARK.modified}
        <li role="option" aria-selected={selectedPath === file.path}>
          <button type="button" class="file-row" class:is-active={selectedPath === file.path} onclick={() => (selectedPath = file.path)} title={file.path}>
            <span class="w-3 shrink-0 text-center text-[10.5px] font-semibold {mark.tone}">{mark.letter}</span>
            <span class="min-w-0 flex-1 truncate">
              <span class="text-foreground">{parts.name}</span>
              {#if parts.dir}<span class="ml-1.5 text-muted-foreground">{parts.dir}</span>{/if}
            </span>
            <span class="shrink-0 text-[11px] tabular-nums">
              {#if file.additions}<span class="text-success">+{file.additions}</span>{/if}
              {#if file.deletions}<span class="ml-1 text-error">−{file.deletions}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>

    {#if selected}
      <!-- The diff sits in an inset box, like the browser's page. -->
      <div class="diff-box">
        <div class="diff-bar">
          <span class="min-w-0 flex-1 truncate font-mono" title={selected.path}>{selected.path}</span>
          {#if selected.kind !== 'deleted'}
            <button type="button" class="ui-chip" onclick={() => openFile(selected.path)} title={$t('codeWs.openFile')}><FolderOpen /> {$t('codeWs.open')}</button>
          {/if}
          {#if !selected.patches}
            <button type="button" class="ui-chip" onclick={() => void revert(selected)} title={$t('codeWs.revert')}><Undo2 /> {$t('codeWs.revert')}</button>
          {/if}
        </div>
        <div class="diff-scroll">
          {#if selected.patches}
            {#each selected.patches as patch, index (index)}
              <DiffRows rows={parsePatch(patch)} path={selected.path} />
            {/each}
          {:else if diffLoading && !diff}
            <div class="flex justify-center py-6"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
          {:else if diff?.binary}
            <p class="diff-note">{$t('codeWs.binary')}</p>
          {:else if diff?.tooLarge}
            <p class="diff-note">{$t('codeWs.tooLarge')}</p>
          {:else if diff}
            <DiffView before={diff.before} after={diff.after} path={selected.path} />
          {/if}
        </div>
      </div>
    {/if}

    {#if list?.source === 'checkpoints'}
      <p class="changes-foot">{$t('codeWs.checkpointNote')}</p>
    {/if}
  {/if}
</aside>

<style>
  .changes {
    display: flex;
    height: 100%;
    min-height: 0;
    width: 100%;
    flex-direction: column;
    background: var(--card);
  }

  .changes-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.125rem;
    padding: 0 0.3rem 0 0.75rem;
    font-size: 12.5px;
  }

  .changes-empty {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.25rem 0.75rem;
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.55;
  }

  .changes-list {
    max-height: 40%;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 0 4px 4px;
  }

  .file-row {
    display: flex;
    width: 100%;
    height: 1.625rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.6rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 12px;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .file-row:hover,
  .file-row.is-active {
    background: var(--surface-hover);
  }

  .diff-box {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    margin: 0 4px 4px;
    overflow: hidden;
    border-radius: 8px;
    background: var(--muted);
  }

  .diff-bar {
    display: flex;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.4rem 0 0.75rem;
    color: var(--muted-foreground);
    font-size: 11px;
  }

  .diff-scroll {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
  }

  .diff-note {
    padding: 1.5rem 1rem;
    color: var(--muted-foreground);
    font-size: 12px;
    text-align: center;
  }

  .changes-foot {
    flex-shrink: 0;
    padding: 0.25rem 0.75rem 0.5rem;
    color: var(--muted-foreground);
    font-size: 11px;
    line-height: 1.5;
  }
</style>
