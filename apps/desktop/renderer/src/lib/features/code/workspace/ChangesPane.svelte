<svelte:options runes={true} />

<!--
  Changes: every file that differs from its "before" (git HEAD in a
  repository, the agent's first snapshot otherwise), with a unified diff of
  the selected file and a per-file revert.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { FileCode2, FolderOpen, LoaderCircle, RefreshCw, Undo2, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import DiffView from './DiffView.svelte';
  import type { ChangedFile, FileDiff } from '$shared/code-workspace';

  let { chatId, projectRoot, sessionId }: { chatId: string; projectRoot: string; sessionId?: string } = $props();

  const args = $derived({ chatId, projectRoot, ...(sessionId ? { sessionId } : {}) });
  const list = $derived(codeWorkspace.changes);
  const files = $derived(list?.files ?? []);
  const totals = $derived(files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 }));

  let selectedPath = $state<string | null>(null);
  let diff = $state<FileDiff | null>(null);
  let diffLoading = $state(false);

  function refresh() {
    void codeWorkspace.refreshChanges(args);
  }

  // "View changes" from the transcript picks its file once it is listed.
  $effect(() => {
    const wanted = codeWorkspace.focusPath;
    if (!wanted) return;
    const match = files.find((f) => f.path === wanted || wanted.endsWith(`/${f.path}`) || f.path.endsWith(wanted));
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
    if (!path) {
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

  const KIND_MARK: Record<ChangedFile['kind'], { letter: string; tone: string }> = {
    created: { letter: 'A', tone: 'text-success' },
    modified: { letter: 'M', tone: 'text-warning' },
    deleted: { letter: 'D', tone: 'text-error' },
    renamed: { letter: 'R', tone: 'text-muted-foreground' }
  };

  async function revert(file: ChangedFile) {
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
    void invoke('open_workspace_file', { absolutePath: `${projectRoot.replace(/[\\/]+$/, '')}/${path}`, workspaceRoot: projectRoot }).catch(() => {});
  }
</script>

<aside class="flex h-full min-h-0 w-full flex-col bg-background" aria-label={$t('codeWs.changes')}>
  <header class="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
    <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
      {$t('codeWs.changes')}
      {#if files.length}
        <span class="ml-1 text-xs font-normal text-muted-foreground">{$t('codeWs.fileCount', { values: { n: files.length } })}</span>
        <span class="ml-1 font-mono text-[11px]"><span class="text-success">+{totals.add}</span> <span class="text-error">−{totals.del}</span></span>
      {/if}
    </p>
    <Button variant="ghost" size="icon-sm" onclick={refresh} disabled={codeWorkspace.changesLoading} aria-label={$t('codeWs.refresh')} title={$t('codeWs.refresh')}>
      <RefreshCw class={codeWorkspace.changesLoading ? 'animate-spin' : ''} />
    </Button>
    <Button variant="ghost" size="icon-sm" onclick={() => codeWorkspace.toggleChanges(false)} aria-label={$t('codeWs.close')} title={$t('codeWs.close')}><X /></Button>
  </header>

  {#if !list && codeWorkspace.changesLoading}
    <div class="flex flex-1 items-center justify-center"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
  {:else if !files.length}
    <!-- Empty: a quiet note at the top, not a poster in the middle. -->
    <div class="flex items-start gap-2 px-4 py-3">
      <FileCode2 class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div class="min-w-0">
        <p class="text-[13px] font-medium text-foreground">{$t('codeWs.noChanges')}</p>
        <p class="text-xs leading-relaxed text-muted-foreground">{list?.source === 'git' ? $t('codeWs.noChangesGit') : $t('codeWs.noChangesHint')}</p>
      </div>
    </div>
  {:else}
    <ul class="max-h-[40%] shrink-0 overflow-y-auto border-b border-[var(--border-subtle)] py-1" role="listbox" aria-label={$t('codeWs.changes')}>
      {#each files as file (file.path)}
        {@const parts = split(file.path)}
        {@const mark = KIND_MARK[file.kind]}
        {@const active = selectedPath === file.path}
        <li role="option" aria-selected={active}>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors {active ? 'bg-[var(--surface-active)]' : 'hover:bg-[var(--surface-hover)]'}"
            onclick={() => (selectedPath = file.path)}
            title={file.path}
          >
            <span class="w-3 shrink-0 text-center font-mono text-[11px] font-semibold {mark.tone}">{mark.letter}</span>
            <span class="min-w-0 flex-1 truncate text-[12px]">
              <span class="text-foreground">{parts.name}</span>
              {#if parts.dir}<span class="ml-1.5 text-muted-foreground">{parts.dir}</span>{/if}
            </span>
            <span class="shrink-0 font-mono text-[11px] tabular-nums">
              {#if file.additions}<span class="text-success">+{file.additions}</span>{/if}
              {#if file.deletions}<span class="ml-1 text-error">−{file.deletions}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>

    {#if selectedPath}
      {@const file = files.find((f) => f.path === selectedPath)}
      <div class="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] px-3">
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={selectedPath}>{selectedPath}</span>
        {#if file && file.kind !== 'deleted'}
          <Button variant="ghost" size="xs" onclick={() => openFile(file.path)} title={$t('codeWs.openFile')}><FolderOpen /> {$t('codeWs.open')}</Button>
        {/if}
        {#if file}
          <Button variant="ghost" size="xs" onclick={() => void revert(file)} title={$t('codeWs.revert')}><Undo2 /> {$t('codeWs.revert')}</Button>
        {/if}
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
        {#if diffLoading && !diff}
          <div class="flex justify-center py-6"><LoaderCircle class="size-4 animate-spin text-muted-foreground" /></div>
        {:else if diff?.binary}
          <p class="px-4 py-6 text-center text-xs text-muted-foreground">{$t('codeWs.binary')}</p>
        {:else if diff?.tooLarge}
          <p class="px-4 py-6 text-center text-xs text-muted-foreground">{$t('codeWs.tooLarge')}</p>
        {:else if diff}
          <DiffView before={diff.before} after={diff.after} />
        {/if}
      </div>
    {/if}

    {#if list?.source === 'checkpoints'}
      <p class="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">{$t('codeWs.checkpointNote')}</p>
    {/if}
  {/if}
</aside>
