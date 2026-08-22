<svelte:options runes={true} />

<script lang="ts">
  import { ChevronLeft, ChevronRight, FileCode, Pencil, Plus, Trash2 } from 'lucide-svelte';
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
  <Select value={selectedPath} options={files.map(([path]) => ({ value: path, label: path }))} onchange={onselect} aria-label="Artifact file" variant="surface" class="w-full" />
</div>

<aside class:collapsed class="file-rail min-h-0 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--muted)]">
  <div class="flex h-10 items-center justify-between border-b border-[var(--border-subtle)] px-2">
    {#if !collapsed}<span class="px-1 text-[11px] font-semibold text-muted-foreground">Files</span>{/if}
    <Button variant="ghost" size="icon-sm" onclick={ontoggle} aria-label={collapsed ? 'Expand files' : 'Collapse files'}>
      {#if collapsed}<ChevronRight />{:else}<ChevronLeft />{/if}
    </Button>
  </div>
  {#if !collapsed}
    <div class="flex items-center gap-0.5 border-b border-[var(--border-subtle)] p-1.5">
      <Button variant="ghost" size="icon-sm" onclick={oncreate} aria-label="Create file"><Plus /></Button>
      <Button variant="ghost" size="icon-sm" onclick={onrename} disabled={!selectedPath} aria-label="Rename selected file"><Pencil /></Button>
      <Button variant="ghost" size="icon-sm" onclick={ondelete} disabled={!selectedPath} aria-label="Delete selected file"><Trash2 /></Button>
    </div>
    <div class="min-h-0 overflow-auto p-1.5">
      {#each files as [path] (path)}
        <button type="button" class:active={path === selectedPath} class="file-row" onclick={() => onselect(path)} title={path}>
          <FileCode class="size-3.5 shrink-0" /><span class="truncate">{path}</span>
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
