<script lang="ts">
  import { ChevronLeft, ChevronRight, Minus, Plus, Trash2 } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Checkbox from '$lib/components/ui/Checkbox.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import AttachmentTile from './AttachmentTile.svelte';
  import { SHELF_LIMIT, type DraftAttachment } from './attachment-shelf';
  import { formatBytes } from '$lib/utils/format';
  import { toastStore } from '$lib/stores/toast.svelte';
  let { files, onremove }: { files: DraftAttachment[]; onremove: (id: string) => void } = $props();
  let gallery = $state(false);
  let activeId = $state<string | null>(null);
  let selected = $state<string[]>([]);
  let source = $state<string | null>(null);
  let loading = $state(false);
  let previewError = $state('');
  let zoom = $state(1);
  let Viewer = $state<typeof import('../DocumentViewer.svelte').default>();
  const active = $derived(files.find(file => file.id === activeId));
  const index = $derived(files.findIndex(file => file.id === activeId));
  const hidden = $derived(Math.max(0, files.length - SHELF_LIMIT));
  const attention = $derived(files.filter(file => file.status === 'error' || file.status === 'processing').length);
  const selectedIds = $derived(selected.filter(id => files.some(file => file.id === id)));
  $effect(() => {
    const file = active;
    const initialSource = file?.source || null;
    zoom = 1; source = initialSource; previewError = ''; loading = false;
    if (!file) return;
    let current = true;
    if (!initialSource && file.loadSource) {
      loading = true;
      void file.loadSource().then(value => { if (current) source = value; }).catch(error => { if (current) previewError = String(error); }).finally(() => { if (current) loading = false; });
    }
    if (file.kind !== 'image') void import('../DocumentViewer.svelte').then(module => { if (current) Viewer = module.default; }).catch(error => { if (current) previewError = String(error); });
    return () => { current = false; };
  });
  $effect(() => { if (activeId && !active) activeId = null; if (!files.length) { gallery = false; selected = []; } });
  function select(id: string, value: boolean) { selected = value ? [...new Set([...selected, id])] : selected.filter(item => item !== id); }
  function step(direction: number) { if (files.length) activeId = files[(index + direction + files.length) % files.length].id; }
  function keys(event: KeyboardEvent) {
    if (!active || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable=true]')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); step(event.key === 'ArrowLeft' ? -1 : 1); }
  }
</script>
<svelte:window onkeydown={keys} />
{#if files.length}
  <section class="attachment-shelf" aria-label="Draft attachments">
    <div class="shelf-heading"><span>Attachments <span class="muted">{files.length}</span></span><Button variant="plain" class="shelf-manage" onclick={() => gallery = true}>Manage</Button></div>
    <div class="shelf-grid" class:has-more={hidden > 0}>
      {#each files.slice(0, SHELF_LIMIT) as file (file.id)}<AttachmentTile {file} onpreview={() => activeId = file.id} onremove={() => onremove(file.id)} />{/each}
      {#if hidden}<Button variant="plain" class="shelf-more" aria-label={`View all ${files.length} attachments`} onclick={() => gallery = true}><span>+{hidden}</span><span>View all</span></Button>{/if}
    </div>
    {#if attention}<Button variant="plain" class="shelf-attention" onclick={() => gallery = true}>{attention} {attention === 1 ? 'file needs' : 'files need'} attention · Manage</Button>{/if}
  </section>
{/if}
{#if gallery && files.length}
  <Dialog title={`Attachments · ${files.length}`} description="Review before sending" size="full" onclose={() => gallery = false}>
    <div class="gallery-tools"><label><Checkbox checked={selectedIds.length === files.length} indeterminate={selectedIds.length > 0 && selectedIds.length < files.length} onchange={event => selected = event.currentTarget.checked ? files.map(file => file.id) : []} /> Select all</label><Button variant="ghost" size="sm" disabled={!selectedIds.length} onclick={() => { for (const id of selectedIds) onremove(id); selected = []; }}><Trash2 class="size-3.5" /> Remove {selectedIds.length || ''} selected</Button></div>
    <div class="attachment-gallery-grid">
      {#each files as file (file.id)}<AttachmentTile {file} selectable selected={selectedIds.includes(file.id)} onselect={value => select(file.id, value)} onpreview={() => activeId = file.id} onremove={() => onremove(file.id)} />{/each}
    </div>
    {#snippet footer()}<span class="muted gallery-status">{files.length} files · Not sent yet</span><Button variant="ghost" size="sm" onclick={() => gallery = false}>Back to draft</Button>{/snippet}
  </Dialog>
{/if}
{#if active}
  <Dialog title={active.name} description={`${formatBytes(active.size, '')} · Not sent yet`} size="full" class="draft-attachment-fullscreen" onclose={() => activeId = null}>
    {#snippet headerActions()}<span class="preview-position">{index + 1} of {files.length}</span><IconButton label="Previous attachment" disabled={files.length < 2} onclick={() => step(-1)}><ChevronLeft /></IconButton><IconButton label="Next attachment" disabled={files.length < 2} onclick={() => step(1)}><ChevronRight /></IconButton>{/snippet}
    <div class="draft-preview">
      {#if loading}<p class="preview-note" role="status">Loading preview…</p>
      {:else if previewError}<div class="preview-note" role="alert"><p>{previewError}</p>{#if active.openExternal}<Button variant="ghost" size="sm" onclick={() => active?.openExternal?.().catch(error => toastStore.error(String(error)))}>Open in default app</Button>{/if}</div>
      {:else if active.kind === 'image' && source}<div class="draft-image-stage"><img src={source} alt={active.name} style:transform={`scale(${zoom})`} onerror={() => previewError = 'This image could not be displayed.'} /></div>
      {:else if active.kind === 'audio' && source}<audio controls src={source}></audio>
      {:else if active.kind === 'video' && source}<video controls src={source}><track kind="captions" /></video>
      {:else if (source || active.content) && Viewer}<Viewer doc={{ id:active.id, name:active.name, type:active.type, dataUrl:source || undefined, content:active.content }} />
      {:else}<div class="preview-note"><p>{active.status === 'processing' ? 'This file is still preparing.' : active.error || 'A preview is not available for this file.'}</p>{#if active.openExternal}<Button variant="ghost" size="sm" onclick={() => active?.openExternal?.().catch(error => toastStore.error(String(error)))}>Open in default app</Button>{/if}</div>{/if}
    </div>
    <div class="preview-rail" aria-label="Attachment navigation">{#each files as file (file.id)}<Button variant="plain" class="preview-rail-item" aria-pressed={file.id === activeId} title={file.name} onclick={() => activeId = file.id}>{file.name}</Button>{/each}</div>
    {#snippet footer()}{#if active.kind === 'image' && source}<div class="preview-zoom"><IconButton label="Zoom out" disabled={zoom <= 0.5} onclick={() => zoom = Math.max(0.5, zoom - 0.25)}><Minus /></IconButton><Button variant="ghost" size="sm" onclick={() => zoom = 1}>{zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}</Button><IconButton label="Zoom in" disabled={zoom >= 3} onclick={() => zoom = Math.min(3, zoom + 0.25)}><Plus /></IconButton></div>{/if}<Button variant="ghost" size="sm" onclick={() => activeId = null}>{gallery ? 'Back to attachments' : 'Back to draft'}</Button>{/snippet}
  </Dialog>
{/if}
<style>
  .attachment-shelf { padding:0.5rem 0; min-width:0; }
  .shelf-heading { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; font-size:var(--text-xs); margin-bottom:0.5rem; }
  .muted,.preview-position { color:var(--muted-foreground); font-size:var(--text-xs); }
  .shelf-heading .muted { margin-left:0.25rem; }
  :global(.shelf-manage),:global(.shelf-attention) { color:var(--muted-foreground); font-size:var(--text-xs); }
  .shelf-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0.625rem; }
  .shelf-grid.has-more { grid-template-columns:repeat(3,minmax(0,1fr)) minmax(2.5rem,0.6fr); }
  :global(.shelf-more) { display:flex; flex-direction:column; align-items:center; justify-content:center; align-self:start; min-width:0; height:5rem; background:var(--muted); color:var(--muted-foreground); font-size:var(--text-xs); }
  :global(.shelf-more > span:first-child) { font-size:var(--text-base); color:var(--foreground); }
  :global(.shelf-attention) { margin-top:0.5rem; }
  .gallery-tools { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; padding:0.75rem 1rem; flex-shrink:0; }
  .gallery-tools label { display:flex; align-items:center; gap:0.5rem; font-size:var(--text-sm); }
  .attachment-gallery-grid { overflow:auto; min-height:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(8rem,1fr)); align-content:start; gap:1.25rem 1rem; padding:0.5rem 1rem 1rem; }
  .gallery-status { margin-right:auto; }
  :global(.draft-attachment-fullscreen) { position:fixed; inset:0; width:100%; height:100dvh; max-height:none; max-width:none; border:0; border-radius:0; }
  .draft-preview { display:flex; flex:1; min-height:0; overflow:auto; background:var(--muted); }
  .draft-image-stage { display:flex; align-items:center; justify-content:center; width:100%; min-height:100%; overflow:auto; }
  .draft-image-stage img { display:block; max-width:100%; max-height:calc(100dvh - 13rem); object-fit:contain; transform-origin:center; }
  .draft-preview video,.draft-preview audio { max-width:100%; max-height:100%; margin:auto; }
  .preview-note { margin:auto; padding:1.5rem; color:var(--muted-foreground); font-size:var(--text-sm); }
  .preview-rail { display:flex; gap:0.5rem; overflow:auto; flex-shrink:0; padding:0.5rem 1rem; }
  :global(.preview-rail-item) { flex:0 0 auto; max-width:10rem; padding:0.375rem 0.625rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--text-xs); background:var(--muted); }
  :global(.preview-rail-item[aria-pressed=true]) { background:var(--foreground); color:var(--background); }
  .preview-zoom { display:flex; align-items:center; margin-right:auto; }
  @media(max-width:480px) { .attachment-gallery-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .preview-position { display:none; } }
</style>
