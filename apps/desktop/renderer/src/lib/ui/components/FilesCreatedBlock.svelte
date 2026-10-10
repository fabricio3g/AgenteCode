<script lang="ts">
  import type { CreatedFile } from '$lib/types/chat';
  import { FilePlus } from 'lucide-svelte';
  import { getFileIcon, fileAccent } from '$lib/utils/doc-utils';

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
        {@const FileIcon = getFileIcon(file.name || file.path)}
        <div class="flex items-center gap-2 border-t border-[var(--border-subtle)] py-1.5">
          <span class="file-tile" style:--file-accent={fileAccent(file.name || file.path)} aria-hidden="true">
            <FileIcon class="size-3" />
          </span>
          <span class="min-w-0 flex-1 truncate text-xs text-[var(--text)]">{file.path}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* The tile carries the file kind's accent and the glyph stays white — the
     same read as the artifact cards, so a list of created files scans by
     colour before it is read. */
  .file-tile {
    display: inline-flex;
    width: 1.375rem;
    height: 1.375rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    background: var(--file-accent);
    color: #fff;
  }
</style>
