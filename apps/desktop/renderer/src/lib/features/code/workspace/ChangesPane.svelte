<svelte:options runes={true} />

<!--
  Changes: every file that differs from its "before" (git HEAD in a
  repository, the agent's first snapshot otherwise), with a unified diff of
  the selected file and a per-file revert.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Button, PaneHeader, Tooltip } from '$lib/components/ui';
  import { conversationScope } from '$shared/workspace-scope';
  import { t } from 'svelte-i18n';
  import { FileCode2, FolderOpen, GitBranch, GitPullRequest, LoaderCircle, RefreshCw, Trash2, TriangleAlert, Undo2, X } from '$lib/icons';
  import { invoke } from '$lib/services/bridge';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { SessionWorktree } from '$shared/agente-protocol';
  import { codeStore } from '../code.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import { parsePatch } from '../patch';
  import DiffRows from '../DiffRows.svelte';
  import DiffView from './DiffView.svelte';
  import type { ChangeKind, FileDiff } from '$shared/code-workspace';

  let {
    chatId,
    projectRoot,
    sessionId,
    worktree = null,
    embedded = false
  }: {
    chatId: string;
    projectRoot: string;
    sessionId?: string;
    worktree?: SessionWorktree | null;
    embedded?: boolean;
  } = $props();

  let merging = $state(false);
  let removing = $state(false);
  let isolating = $state(false);
  let confirmRemove = $state(false);
  let mergeConflicts = $state<string[]>([]);

  async function handleIsolateWorktree() {
    if (worktree || isolating) return;
    isolating = true;
    try {
      await codeStore.enableWorktree(chatId);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      isolating = false;
    }
  }

  $effect(() => {
    void worktree?.path;
    mergeConflicts = [];
    confirmRemove = false;
  });

  async function handleMergeWorktree() {
    if (!worktree || merging || removing) return;
    merging = true;
    mergeConflicts = [];
    try {
      const result = await codeStore.mergeConversationWorktree(chatId, { removeAfter: false });
      if (result.merged) {
        toastStore.success($t('code.worktree.merged', { values: { commit: result.commit.slice(0, 7) } }));
      } else {
        mergeConflicts = result.conflicts;
      }
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      merging = false;
    }
  }

  async function handleRemoveWorktree() {
    if (!worktree || merging || removing) return;
    removing = true;
    try {
      await codeStore.removeConversationWorktree(chatId);
      confirmRemove = false;
      mergeConflicts = [];
      toastStore.success($t('code.worktree.removed'));
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      removing = false;
    }
  }

  /** A listed file: from git, or only from the transcript's own record of an edit. */
  type Entry = { path: string; kind: ChangeKind; additions: number; deletions: number; patches?: string[] };

  const args = $derived({ chatId, projectRoot, ...(sessionId ? { sessionId } : {}) });
  const list = $derived(codeWorkspace.changesFor(chatId));
  // The branch chip keeps this loaded; `list.branch` is the fallback for a pane
  // that rendered before the chip asked, and it is refreshed with the changes.
  const branch = $derived(codeWorkspace.branchFor(projectRoot)?.current ?? list?.branch ?? '');
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
    const wanted = codeWorkspace.focusPaths[conversationScope(chatId)];
    if (!wanted) return;
    const match = files.find((f) => samePath(f.path, relative(wanted)));
    if (match) {
      selectedPath = match.path;
      codeWorkspace.focusPaths[conversationScope(chatId)] = null;
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
      diffLoading = false;
      return;
    }
    const owner = chatId;
    let cancelled = false;
    diffLoading = true;
    void codeWorkspace.fileDiff({ ...args, path })
      .then((result) => { if (!cancelled && owner === chatId && selectedPath === path) diff = result; })
      .catch(() => { if (!cancelled && owner === chatId && selectedPath === path) diff = null; })
      .finally(() => { if (!cancelled && owner === chatId && selectedPath === path) diffLoading = false; });
    return () => { cancelled = true; };
  });

  function split(path: string): { name: string; dir: string } {
    const index = path.lastIndexOf('/');
    return index < 0 ? { name: path, dir: '' } : { name: path.slice(index + 1), dir: path.slice(0, index) };
  }

  const KIND_MARK: Record<ChangeKind, { letter: string; tone: string }> = {
    created: { letter: 'A', tone: 'text-success' },
    modified: { letter: 'M', tone: 'text-muted-foreground' },
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
  <PaneHeader>
    <p class="min-w-0 flex-1 truncate" title={list?.source === 'checkpoints' ? $t('codeWs.checkpointNote') : undefined}>
      {#if !embedded}<span class="font-medium text-foreground">{$t('codeWs.changes')}</span>{/if}
      {#if branch}
        <span class="branch-label" title={$t('codeWs.branch')}><GitBranch class="size-3" aria-hidden="true" />{branch}</span>
      {/if}
      {#if files.length}
        <span class="ml-1.5 text-muted-foreground">{$t('codeWs.fileCount', { values: { n: files.length } })}</span>
        <span class="ml-1 tabular-nums"><span class="text-success">+{totals.add}</span> <span class="text-error">−{totals.del}</span></span>
      {/if}
    </p>
    {#snippet actions()}
    {#if !worktree && (list?.source === 'git' || !!branch)}
      <Tooltip label={$t('code.worktree.commandHint')} position="bottom">
        <Button variant="ghost" size="xs" type="button" disabled={isolating || !!codeStore.runFor(chatId)?.running} onclick={() => void handleIsolateWorktree()}>
          {#if isolating}<LoaderCircle class="size-3 animate-spin" />{:else}<GitBranch class="size-3" />{/if}
          {$t('code.worktree.isolateShort')}
        </Button>
      </Tooltip>
    {/if}
    <Tooltip label={$t('codeWs.refresh')} position="bottom"><UiIconButton label={$t('codeWs.refresh')} size="xs" type="button" class={uiClass(" ", "ui-local-8f978f5f")} onclick={refresh} disabled={codeWorkspace.changeLoading[chatId]} >
      <RefreshCw class={codeWorkspace.changeLoading[chatId] ? 'animate-spin' : ''} />
    </UiIconButton></Tooltip>
    {#if !embedded}<Tooltip label={$t('codeWs.close')} position="bottom"><UiIconButton label={$t('codeWs.close')} size="xs" type="button" class={uiClass(" ", "ui-local-8f978f5f")} onclick={() => codeWorkspace.toggleChanges(false)} ><X /></UiIconButton></Tooltip>{/if}
    {/snippet}
  </PaneHeader>

  {#if worktree}
    <div class="worktree-strip">
      <div class="worktree-id">
        <GitBranch class="size-3.5 shrink-0 text-[var(--brand-accent-strong)]" aria-hidden="true" />
        <span class="truncate font-mono" title={worktree.path}>{worktree.branch}</span>
        <span class="worktree-tag">{$t('code.worktree.isolated')}</span>
      </div>
      <div class="worktree-actions">
        {#if confirmRemove}
          <span class="text-xs text-muted-foreground">{$t('code.worktree.confirmRemove')}</span>
          <Button variant="ghost" size="xs" type="button" disabled={removing} onclick={() => (confirmRemove = false)}>
            {$t('code.worktree.cancel')}
          </Button>
          <Button variant="destructive" size="xs" type="button" disabled={removing} onclick={() => void handleRemoveWorktree()}>
            {#if removing}<LoaderCircle class="size-3 animate-spin" />{:else}<Trash2 class="size-3" />{/if}
            {$t('code.worktree.remove')}
          </Button>
        {:else}
          <Button variant="outline" size="xs" type="button" disabled={merging || removing} onclick={() => void handleMergeWorktree()}>
            {#if merging}<LoaderCircle class="size-3 animate-spin" />{:else}<GitPullRequest class="size-3" />{/if}
            {$t('code.worktree.merge')}
          </Button>
          <Button variant="ghost" size="xs" type="button" disabled={merging || removing} onclick={() => (confirmRemove = true)} title={$t('code.worktree.remove')}>
            <Trash2 class="size-3" />
            {$t('code.worktree.remove')}
          </Button>
        {/if}
      </div>
    </div>
    {#if mergeConflicts.length}
      <div class="conflict-strip" role="alert">
        <div class="flex items-start gap-2 min-w-0 flex-1">
          <TriangleAlert class="size-3.5 shrink-0 text-error mt-0.5" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium text-error">{$t('code.worktree.conflictsTitle')}</p>
            <p class="text-xs text-muted-foreground">{$t('code.worktree.conflictsHint')}</p>
            <ul class="mt-1 space-y-0.5 font-mono text-xs text-foreground">
              {#each mergeConflicts as file (file)}
                <li class="truncate">{file}</li>
              {/each}
            </ul>
          </div>
        </div>
        <Button variant="ghost" size="xs" type="button" onclick={() => (mergeConflicts = [])}>
          {$t('code.worktree.dismiss')}
        </Button>
      </div>
    {/if}
  {/if}

  {#if !list && codeWorkspace.changeLoading[chatId]}
    <div class="flex flex-1 items-center justify-center"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
  {:else if !files.length}
    <!-- Empty: a quiet note at the top, not a poster in the middle. -->
    <div class="pane-body"><p class="pane-empty"><FileCode2 class="size-3.5" />{$t('codeWs.noChanges')}</p></div>
  {:else}
    <ul class="changes-list" role="listbox" aria-label={$t('codeWs.changes')}>
      {#each files as file (file.path)}
        {@const parts = split(file.path)}
        {@const mark = KIND_MARK[file.kind] ?? KIND_MARK.modified}
        <li role="option" aria-selected={selectedPath === file.path}>
          <UiListRow  type="button" class={uiClass("file-row", "ui-local-8f978f5f", {"is-active": selectedPath === file.path})}  onclick={() => (selectedPath = file.path)} title={file.path}>
            <span class="w-3 shrink-0 text-center text-[length:var(--text-xs)] font-semibold {mark.tone}">{mark.letter}</span>
            <span class="min-w-0 flex-1 truncate">
              <span class="text-foreground">{parts.name}</span>
              {#if parts.dir}<span class="ml-1.5 text-muted-foreground">{parts.dir}</span>{/if}
            </span>
            <span class="pane-row-aside pane-churn">
              {#if file.additions}<span class="text-success">+{file.additions}</span>{/if}
              {#if file.deletions}<span class="text-error">−{file.deletions}</span>{/if}
            </span>
          </UiListRow>
        </li>
      {/each}
    </ul>

    {#if selected}
      <!-- The diff sits in an inset box, like the browser's page. -->
      <div class="diff-box">
        <div class="diff-bar">
          <span class="min-w-0 flex-1 truncate" title={selected.path}>{selected.path}</span>
          {#if selected.kind !== 'deleted'}
            <Button variant="outline" size="xs" type="button" onclick={() => openFile(selected.path)} title={$t('codeWs.openFile')}><FolderOpen /> {$t('codeWs.open')}</Button>
          {/if}
          {#if !selected.patches}
            <Button variant="outline" size="xs" type="button" onclick={() => void revert(selected)} title={$t('codeWs.revert')}><Undo2 /> {$t('codeWs.revert')}</Button>
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

  {/if}
</aside>

<style>
  .changes {
    display: flex;
    height: 100%;
    min-height: 0;
    width: 100%;
    flex-direction: column;
    /* The pane frame is the surface; the body adds none of its own. */
    background: transparent;
  }


  /* The branch sits beside the file count, quiet enough to not read as a count. */
  .branch-label {
    display: inline-flex;
    max-width: 12rem;
    align-items: center;
    gap: 0.25rem;
    margin-left: 0.5rem;
    vertical-align: -2px;
    color: var(--muted-foreground);
  }
  .branch-label :global(svg) { flex-shrink: 0; }

  .worktree-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
    padding: 0.4375rem 0.75rem;
    font-size: var(--text-xs);
  }
  .worktree-id {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    color: var(--foreground);
  }
  .worktree-tag {
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
  .worktree-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }
  .conflict-strip {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid var(--error-border, var(--border-subtle));
    background: color-mix(in srgb, var(--error) 8%, transparent);
    padding: 0.5rem 0.75rem;
  }

  .changes-list {
    /* Rows are full-radius hover pills: with no gap they merge into one band,
       and with no top inset the first one sits on the bar above it. */
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-height: 40%;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 0.25rem 0.75rem 0.5rem;
  }

  :is(.file-row, :global(.file-row.ui-local-8f978f5f)) {
    display: flex;
    width: 100%;
    height: var(--sidebar-row-h);
    align-items: center;
    gap: 0.625rem;
    padding: 0 0.5rem;
    border-radius: var(--float-row-radius);
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    text-align: left;
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  :is(.file-row:hover, :global(.file-row:hover.ui-local-8f978f5f)) {
    background: var(--float-row-hover);
    color: var(--foreground);
  }
  :is(.file-row.is-active, :global(.file-row.is-active.ui-local-8f978f5f)) {
    background: var(--float-row-selected);
    box-shadow: inset 0 1px 0 var(--composer-crown), inset 0 0 0 1px var(--float-border);
    color: var(--foreground);
    font-weight: 500;
  }

  .diff-box {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    /* The path bar and the first diff line are two things, not one. */
    gap: 0.125rem;
    margin: 0 0.75rem 0.75rem;
    overflow: hidden;
    border: 1px solid var(--float-border);
    border-radius: var(--radius-md);
    box-shadow: var(--control-shadow);
    /* Inset, not raised: code sits in the page's own tone inside the sheet. */
    background: var(--background);
  }

  .diff-bar {
    display: flex;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.4rem 0 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  .diff-scroll {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
  }

  .diff-note {
    padding: 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

</style>
