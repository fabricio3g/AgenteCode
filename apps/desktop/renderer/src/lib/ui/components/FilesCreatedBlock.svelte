<script lang="ts">
  import type { CreatedFile } from '$lib/types/chat';
  import { FilePlus, FolderOpen } from 'lucide-svelte';

  interface Props {
    files?: CreatedFile[];
  }

  let { files = [] }: Props = $props();
</script>

{#if files.length}
  <div class="mt-4">
    <div class="mb-2 flex items-center gap-2 text-xs font-semibold text-[color:var(--muted-foreground)]">
      <FilePlus class="h-3.5 w-3.5" />
      {files.length === 1 ? 'File created' : `${files.length} files created`}
    </div>
    <div>
      {#each files as file (file.path)}
        <div class="flex items-center gap-2 border-t border-[var(--border-subtle)] py-1.5">
          <FolderOpen class="h-3.5 w-3.5 shrink-0 text-[color:var(--muted-foreground)]" />
          <span class="min-w-0 flex-1 truncate text-xs text-[var(--text)]">{file.path}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}
