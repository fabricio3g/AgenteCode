<svelte:options runes={true} />

<!--
  The canvas tools, floating over the bottom of the canvas: Browse to move
  around the page, Select to pick elements for the next message, Comment to
  pin a note. V / S / C switch tools, but only while focus is outside any
  text field, so typing in the composer never changes the tool.
-->

<script lang="ts" module>
  import { MessageSquarePlus, MousePointer2, SquareDashedMousePointer } from 'lucide-svelte';
  import { copy } from '$lib/copy';
  import type { DesignCanvasTool } from '$shared/design';

  export const TOOLS: { id: DesignCanvasTool; key: string; icon: typeof MousePointer2; label: string }[] = [
    { id: 'browse', key: 'v', icon: MousePointer2, label: copy.design.tools.browse },
    { id: 'select', key: 's', icon: SquareDashedMousePointer, label: copy.design.tools.select },
    { id: 'comment', key: 'c', icon: MessageSquarePlus, label: copy.design.tools.comment }
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
  import { Send } from 'lucide-svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import DesignToolButton from './DesignToolButton.svelte';
  import { designStore } from './design.svelte';

  /**
   * A narrow canvas (an inspector sheet over it) drops the send: it only moves focus to the composer, and the
   * pending comments are listed above that composer, so the pill keeps to its three tools inside the visible canvas.
   */
  let { compact = false }: { compact?: boolean } = $props();

  const comments = $derived(designStore.comments.length);

  function sendComments() {
    window.dispatchEvent(new Event('focus-composer'));
  }
</script>

<div class="pill ui-float" role="toolbar" aria-label={copy.design.tools.label}>
  {#each TOOLS as tool (tool.id)}
    <DesignToolButton icon={tool.icon} label={tool.label} shortcut={tool.key} position="top" pressed={designStore.tool === tool.id} onclick={() => designStore.setTool(tool.id)} />
  {/each}

  {#if comments > 0 && !compact}
    <Button variant="ghost" size="sm" class="ml-1 h-[1.625rem] rounded-full px-2.5 text-xs" onclick={sendComments}>
      <Send class="text-[var(--brand-accent)]" aria-hidden="true" />
      {copy.design.tools.sendComments}
      <Badge>{comments}</Badge>
    </Button>
  {/if}
</div>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    padding: var(--float-pad);
    border-radius: var(--radius-full);
    backdrop-filter: blur(12px);
  }
</style>
