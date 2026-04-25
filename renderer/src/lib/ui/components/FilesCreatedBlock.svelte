<script lang="ts">
  import type { CreatedFile } from '$lib/types/chat';
  import { FilePlus, FolderOpen } from 'lucide-svelte';

  interface Props {
    files?: CreatedFile[];
  }

  let { files = [] }: Props = $props();
</script>

{#if files.length}
  <div class="chateaui-card mt-4 px-4 py-3" style="--chateaui-card-bg: var(--work-accent-soft); --chateaui-card-border: var(--work-accent-border);">
    <div class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-[color:var(--work-accent-strong)]">
      <FilePlus class="h-3.5 w-3.5" />
      {files.length === 1 ? 'File created' : `${files.length} files created`}
    </div>
    <div class="space-y-1.5">
      {#each files as file (file.path)}
        <div class="chateaui-card flex items-center gap-2 px-3 py-2">
          <FolderOpen class="h-3.5 w-3.5 shrink-0 text-[color:var(--work-accent)]" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text)]">{file.path}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}
