<svelte:options runes={true} />

<!--
  What the user pointed at, as small chips above the composer: one wrapping row
  of badges, two lines at most. Chips past what fits wait behind a +N chip that
  expands the row. The same list goes to the agent with the next message
  (designStore.takeTurnContext). Renders nothing when there is nothing pointed at.
-->

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MessageSquare, MousePointer2, Pencil, X } from 'lucide-svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { itemsInRows } from './design-view';
  import { pickLabel } from './design-picker';

  /** The chip row never runs past this many lines before the +N chip takes over. */
  const ROWS = 2;

  interface Chip { id: string; kind: 'pick' | 'note' | 'mark'; label: string; title: string }

  const chips = $derived<Chip[]>([
    ...designStore.selection.map((pick) => ({ id: pick.id, kind: 'pick' as const, label: pickLabel(pick), title: pick.selector })),
    ...designStore.comments.map((comment) => ({ id: comment.id, kind: 'note' as const, label: comment.note, title: comment.selector })),
    ...designStore.strokes.map((stroke, index) => ({ id: stroke.id, kind: 'mark' as const, label: `${copy.design.draw.mark} ${index + 1}`, title: stroke.hits?.join(', ') ?? stroke.page }))
  ]);

  let expanded = $state(false);
  /** How many chips render; the rest wait behind the +N chip. */
  let shown = $state(Infinity);
  let row = $state<HTMLDivElement>();
  let rowWidth = $state(0);
  let pass = 0;

  /**
   * Finds how many chips fit in ROWS lines, with the +N chip and Clear all in the
   * same row. Each try renders its count and reads the tops of the row's children,
   * and `tick` lands the render before the read, so nothing paints mid-search.
   */
  async function fit() {
    const run = (pass += 1);
    if (chips.length === 0) { expanded = false; shown = Infinity; return; }
    if (expanded) { shown = Infinity; return; }
    shown = Infinity;
    await tick();
    if (run !== pass || !row) return;
    let count = chips.length;
    for (;;) {
      shown = count;
      await tick();
      if (run !== pass || !row) return;
      const tops = [...row.children].map((child) => Math.round(child.getBoundingClientRect().top));
      if (count === 0 || itemsInRows(tops, ROWS) === tops.length) break;
      count -= 1;
    }
    shown = count;
  }

  $effect(() => {
    void chips;
    void rowWidth;
    void expanded;
    untrack(() => { void fit(); });
  });

  function remove(chip: Chip) {
    if (chip.kind === 'pick') designStore.removeSelection(chip.id);
    else if (chip.kind === 'mark') designStore.strokes = designStore.strokes.filter((stroke) => stroke.id !== chip.id);
    else designStore.removeComment(chip.id);
  }

  function clearAll() {
    designStore.clearSelection();
    designStore.clearComments();
    designStore.clearStrokes();
  }
</script>

{#if chips.length > 0}
  <div class="chips" role="list" aria-label={copy.design.select.element} bind:this={row} bind:clientWidth={rowWidth}>
    {#each chips.slice(0, shown) as chip (chip.id)}
      <Badge class="design-chip" role="listitem" title={chip.title}>
        {#if chip.kind === 'pick'}
          <MousePointer2 class="chip-icon" aria-hidden="true" />
        {:else if chip.kind === 'mark'}
          <Pencil class="chip-icon" aria-hidden="true" />
        {:else}
          <MessageSquare class="chip-icon" aria-hidden="true" />
        {/if}
        <span class="label">{chip.label}</span>
        <IconButton label={copy.design.select.remove} class="chip-remove" onclick={() => remove(chip)}>
          <X aria-hidden="true" />
        </IconButton>
      </Badge>
    {/each}
    {#if shown < chips.length}
      <Button variant="ghost" size="xs" class="more-chip" aria-label={copy.design.select.showMore} title={copy.design.select.showMore} onclick={() => (expanded = true)}>
        +{chips.length - shown}
      </Button>
    {/if}
    {#if expanded}
      <Button variant="link" size="xs" class="quiet" onclick={() => (expanded = false)}>{copy.design.select.showFewer}</Button>
    {/if}
    {#if chips.length > 1}
      <Button variant="link" size="xs" class="quiet" onclick={clearAll}>{copy.design.select.clearAll}</Button>
    {/if}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.375rem;
    padding: 0 0.25rem 0.5rem;
  }

  :global(.design-chip) {
    max-width: 100%;
    min-width: 0;
    gap: 0.25rem;
    padding-inline: 0.4375rem 0.125rem;
    color: var(--foreground);
    font-family: inherit;
    font-weight: 400;
  }

  :global(.design-chip .chip-icon) {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
    color: var(--brand-accent);
  }

  /* Ellipsized at about two dozen characters; the full selector or note is in the title. */
  .label {
    overflow: hidden;
    min-width: 0;
    max-width: 24ch;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.design-chip .chip-remove) {
    width: 1rem;
    height: 1rem;
  }

  :global(.design-chip .chip-remove svg) {
    width: 0.625rem;
    height: 0.625rem;
  }

  /* The +N chip is a chip too: the same height and hairline as the badges it stands for. */
  :global(.more-chip) {
    height: 1.25rem;
    padding-inline: 0.4375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  :global(.more-chip:hover) { color: var(--foreground); }

  :global(.chips .quiet) { color: var(--muted-foreground); }
</style>
