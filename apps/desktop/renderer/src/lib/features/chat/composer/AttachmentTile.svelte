<script lang="ts">
  import { FileText, Maximize2, X, LoaderCircle } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import { formatBytes } from '$lib/utils/format';
  import { fileTypeLabel } from '../document-surface';
  import type { DraftAttachment } from './attachment-shelf';
  let { file, onpreview, onremove, selectable = false, selected = false, onselect }: {
    file: DraftAttachment; onpreview: () => void; onremove: () => void;
    selectable?: boolean; selected?: boolean; onselect?: (value: boolean) => void;
  } = $props();
  let thumbnail = $state<string | null>(null);
  let broken = $state(false);
  $effect(() => {
    const item = file;
    const initial = item.thumbnail || (item.kind === 'image' ? item.source || null : null);
    thumbnail = initial; broken = false;
    let active = true;
    if (!initial && item.loadThumbnail) void item.loadThumbnail().then(value => { if (active) thumbnail = value; }).catch(() => {});
    return () => { active = false; };
  });
</script>
<div class="attachment-tile">
  <Button variant="plain" class="attachment-tile-preview" title={file.name} aria-label={`Preview ${file.name}`} onclick={onpreview}>
    <span class="tile-art">
      {#if thumbnail && !broken}<img src={thumbnail} alt={file.name} onerror={() => broken = true} />
      {:else if file.status === 'processing'}<LoaderCircle class="size-5 animate-spin" />
      {:else}<FileText class="size-5" />{/if}
    </span>
    <span class="tile-name">{file.name}</span>
    <span class="tile-detail" title={file.error || file.warning}>{file.status === 'error' ? 'Could not read file' : file.status === 'processing' ? 'Preparing…' : `${fileTypeLabel(file.name)} · ${formatBytes(file.size, '')}`}</span>
    <span class="tile-preview-label"><Maximize2 class="size-3" /> Preview</span>
  </Button>
  {#if selectable}<label class="tile-select"><Checkbox checked={selected} onchange={(event) => onselect?.(event.currentTarget.checked)} aria-label={`Select ${file.name}`} /> Select</label>
  {:else}<IconButton class="attachment-tile-remove" label={`Remove ${file.name}`} size="xs" onclick={onremove}><X class="size-3" /></IconButton>{/if}
</div>
<style>
  .attachment-tile { position:relative; min-width:0; }
  :global(.attachment-tile-preview) { display:flex; flex-direction:column; align-items:stretch; width:100%; min-width:0; text-align:left; }
  .tile-art { display:flex; align-items:center; justify-content:center; height:5rem; width:100%; overflow:hidden; border-radius:var(--radius-md); background:var(--muted); color:var(--muted-foreground); }
  .tile-art img { width:100%; height:100%; object-fit:cover; }
  .tile-name,.tile-detail { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--text-xs); }
  .tile-name { margin-top:0.375rem; color:var(--foreground); }
  .tile-detail { color:var(--muted-foreground); }
  .tile-preview-label { display:flex; align-items:center; gap:0.25rem; margin-top:0.25rem; font-size:var(--text-xs); color:var(--muted-foreground); }
  :global(.attachment-tile-remove) { position:absolute; top:0.125rem; right:0.125rem; background:var(--background); }
  .tile-select { display:flex; align-items:center; gap:0.375rem; margin-top:0.5rem; color:var(--muted-foreground); font-size:var(--text-xs); }
</style>
