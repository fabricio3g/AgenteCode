<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { getFileIcon } from '$lib/utils/doc-utils';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';

  interface Props {
    files: Array<[string, string]>;
    selectedPath: string;
    collapsed: boolean;
    onselect: (path: string) => void;
    ontoggle: () => void;
    oncreate: () => void;
    onrename: () => void;
    ondelete: () => void;
  }

  let { files, selectedPath, collapsed, onselect, ontoggle, oncreate, onrename, ondelete }: Props = $props();
</script>

<div class="mobile-files border-b border-[var(--border-subtle)] p-2">
  <Select value={selectedPath} options={files.map(([path]) => ({ value: path, label: path }))} onchange={onselect} aria-label={$t('artifacts.studio.file')} variant="surface" class="w-full" />
  <div class="mt-1 flex gap-1">
    <Button variant="ghost" size="icon-sm" onclick={oncreate} aria-label={$t('artifacts.studio.createFile')}><Plus /></Button>
    <Button variant="ghost" size="icon-sm" onclick={onrename} disabled={!selectedPath} aria-label={$t('artifacts.studio.renameFile')}><Pencil /></Button>
    <Button variant="ghost" size="icon-sm" onclick={ondelete} disabled={!selectedPath} aria-label={$t('artifacts.studio.deleteFile')}><Trash2 /></Button>
  </div>
</div>

<aside class:collapsed class="file-rail min-h-0 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--muted)]">
  <div class="flex h-10 items-center justify-between border-b border-[var(--border-subtle)] px-2">
    {#if !collapsed}<span class="px-1 text-[12px] font-semibold text-muted-foreground">{$t('artifacts.studio.files')}</span>{/if}
    <Button variant="ghost" size="icon-sm" onclick={ontoggle} aria-label={collapsed ? $t('artifacts.studio.expandFiles') : $t('artifacts.studio.collapseFiles')}>
      {#if collapsed}<ChevronRight />{:else}<ChevronLeft />{/if}
    </Button>
  </div>
  {#if !collapsed}
    <div class="flex items-center gap-0.5 border-b border-[var(--border-subtle)] p-1.5">
      <Button variant="ghost" size="icon-sm" onclick={oncreate} aria-label={$t('artifacts.studio.createFile')}><Plus /></Button>
      <Button variant="ghost" size="icon-sm" onclick={onrename} disabled={!selectedPath} aria-label={$t('artifacts.studio.renameFile')}><Pencil /></Button>
      <Button variant="ghost" size="icon-sm" onclick={ondelete} disabled={!selectedPath} aria-label={$t('artifacts.studio.deleteFile')}><Trash2 /></Button>
    </div>
    <div class="min-h-0 overflow-auto p-1.5">
      {#each files as [path] (path)}
        {@const FileIcon = getFileIcon(path)}
        <button type="button" class:active={path === selectedPath} aria-current={path === selectedPath ? 'true' : undefined} class="file-row" onclick={() => onselect(path)} title={path}>
          <FileIcon class="size-3.5 shrink-0" /><span class="truncate">{path}</span>
        </button>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .file-rail { display: flex; width: 13.5rem; flex-direction: column; transition: width 160ms var(--motion-ease); }
  .file-rail.collapsed { width: 2.8rem; }
  .file-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.45rem;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    padding: 0.42rem 0.65rem;
    color: var(--muted-foreground);
    text-align: left;
    font-size: 0.7rem;
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }
  .file-row:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .file-row.active {
    background: var(--surface-active);
    color: var(--foreground);
  }
  .mobile-files { display: none; }
  @media (max-width: 640px) { .file-rail { display: none; } .mobile-files { display: block; } }
</style>
