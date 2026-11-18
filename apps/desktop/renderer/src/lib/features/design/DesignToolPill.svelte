<svelte:options runes={true} />

<!--
  The tool dock, floating over the bottom of the canvas: Browse to move around
  the page, Select to pick elements for the next message, Comment to pin a
  note, Draw to mark up the frame, then the zoom. V / S / C / D switch tools, but only while focus is outside
  any text field, so typing in the composer never changes the tool. The tool in
  hand is the one ember thing on the dock.
-->

<script lang="ts" module>
  import { MessageSquarePlus, MousePointer2, Pencil, SquareDashedMousePointer } from '$lib/icons';
  import { copy } from '$lib/copy';
  import type { DesignCanvasTool } from '$shared/design';

  const TOOLS: { id: DesignCanvasTool; key: string; icon: typeof MousePointer2; label: string }[] = [
    { id: 'browse', key: 'v', icon: MousePointer2, label: copy.design.tools.browse },
    { id: 'select', key: 's', icon: SquareDashedMousePointer, label: copy.design.tools.select },
    { id: 'comment', key: 'c', icon: MessageSquarePlus, label: copy.design.tools.comment },
    { id: 'draw', key: 'd', icon: Pencil, label: copy.design.draw.tool }
  ];

  /**
   * The tool a plain-letter key selects, or null. Plain letters are shortcuts
   * only when no modifier is held and nothing editable has focus, so typing in
   * the composer never changes the tool.
   */
  export function toolForKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>): DesignCanvasTool | null {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('textarea, input, select, [contenteditable="true"]')) return null;
    return TOOLS.find((item) => item.key === event.key.toLowerCase())?.id ?? null;
  }
</script>

<script lang="ts">
  import { Globe, ImagePlus, Minus, Plus, Send, Upload } from '$lib/icons';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import DesignCaptureDialog from './DesignCaptureDialog.svelte';
  import DesignToolButton from './DesignToolButton.svelte';
  import { designStore } from './design.svelte';
  import { ZOOM_PRESETS, zoomLabel } from './design-view';

  /**
   * A narrow canvas (an inspector sheet over it) drops the send: it only moves focus to the composer, and the
   * pending comments are listed above that composer, so the pill keeps to its three tools inside the visible canvas.
   */
  let { compact = false }: { compact?: boolean } = $props();

  const comments = $derived(designStore.comments.length);
  const zoomText = $derived(designStore.zoom === null ? copy.design.toolbar.fit : zoomLabel(designStore.zoom));
  let zoomMenu = $state(false);

  let refMenu = $state(false);
  let captureOpen = $state(false);

  /** Main opens the file dialog and copies the chosen images into references/. */
  async function addImages() {
    try {
      const { failed } = await designStore.pickReferences();
      if (failed) toastStore.error(copy.design.references.someRefused.replace('{n}', String(failed)));
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : copy.design.references.addFailed);
    }
  }

  function sendComments() {
    window.dispatchEvent(new Event('focus-composer'));
  }
</script>

<div class="pill ui-float" role="toolbar" aria-label={copy.design.tools.label}>
  {#each TOOLS as tool (tool.id)}
    <DesignToolButton icon={tool.icon} label={tool.label} shortcut={tool.key} position="top" class="dock-tool" pressed={designStore.tool === tool.id} onclick={() => designStore.setTool(tool.id)} />
  {/each}

  <span class="sep" aria-hidden="true"></span>
  <Menu bind:open={refMenu} placement="top-start" minWidth="13rem" label={copy.design.references.title}>
    {#snippet trigger(props)}
      <IconButton label={copy.design.references.title} class="design-tool" {...props}><ImagePlus aria-hidden="true" /></IconButton>
    {/snippet}
    <MenuItem icon={Upload} label={copy.design.references.add} onselect={() => void addImages()} />
    <MenuItem icon={Globe} label={copy.design.references.capture} onselect={() => (captureOpen = true)} />
  </Menu>
  <span class="sep" aria-hidden="true"></span>
  <div class="zoom" role="group" aria-label={copy.design.toolbar.zoom}>
    {#if !compact}
      <DesignToolButton icon={Minus} label={copy.design.toolbar.zoomOut} shortcut="mod+alt+-" position="top" onclick={() => designStore.zoomBy(-0.1)} />
    {/if}
    <Menu bind:open={zoomMenu} placement="top-start" minWidth="8.5rem" label={copy.design.toolbar.zoom}>
      {#snippet trigger(props)}
        <Button variant="ghost" size="sm" class="h-[1.625rem] min-w-[3rem] px-1.5 text-xs tabular-nums" aria-label={copy.design.toolbar.zoom} title={copy.design.toolbar.zoom} {...props}>{zoomText}</Button>
      {/snippet}
      {#each ZOOM_PRESETS as preset (preset)}
        <MenuItem label={zoomLabel(preset)} active={designStore.zoom === preset} onselect={() => designStore.setZoom(preset)} />
      {/each}
      <MenuItem label={copy.design.toolbar.zoomFit} active={designStore.zoom === null} onselect={() => designStore.setZoom(null)} />
    </Menu>
    {#if !compact}
      <DesignToolButton icon={Plus} label={copy.design.toolbar.zoomIn} shortcut="mod+alt+=" position="top" onclick={() => designStore.zoomBy(0.1)} />
    {/if}
  </div>

  {#if comments > 0 && !compact}
    <Button variant="ghost" size="sm" class="ml-1 h-[1.625rem] rounded-full px-2.5 text-xs" onclick={sendComments}>
      <Send class="text-[var(--brand-accent)]" aria-hidden="true" />
      {copy.design.tools.sendComments}
      <Badge>{comments}</Badge>
    </Button>
  {/if}
</div>
{#if captureOpen}<DesignCaptureDialog onclose={() => (captureOpen = false)} />{/if}

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.1875rem;
    border-radius: var(--radius-lg, 0.75rem);
    backdrop-filter: blur(12px);
  }

  /* The tool in hand: a filled ember square, not the toggle tint the bar's buttons use. */
  .pill :global(.dock-tool.is-on),
  .pill :global(.dock-tool.is-on:hover) {
    background: var(--brand-accent);
    color: #fff;
  }

  .sep {
    align-self: stretch;
    width: 1px;
    margin: 0.3125rem 0.25rem;
    background: var(--border);
  }

  .zoom { display: inline-flex; align-items: center; gap: 0.0625rem; }
</style>
