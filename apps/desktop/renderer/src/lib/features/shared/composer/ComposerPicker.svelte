<script module lang="ts">
  import type { Icon } from '$lib/icons';

  export interface PickerItem {
    id: string;
    label: string;
    hint?: string;
    icon: Icon;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';

  let { id, label, items, selected, floating = false, onhighlight, onselect }: {
    id?: string;
    label: string;
    items: PickerItem[];
    selected: number;
    floating?: boolean;
    onhighlight: (index: number) => void;
    onselect: (index: number) => void;
  } = $props();
  let list = $state<HTMLDivElement>();

  $effect(() => {
    if (items[selected]) list?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  });
</script>

<div bind:this={list} {id} class="picker" class:floating role="listbox" aria-label={label}>
  {#each items as item, index (item.id)}
    <Button variant="plain" type="button" role="option" tabindex={-1}
      id={id ? `${id}-${index}` : undefined}
      aria-selected={index === selected} aria-disabled={item.disabled}
      onclick={() => { if (!item.disabled) onselect(index); }}
      onmousedown={(event) => event.preventDefault()} onmouseenter={() => onhighlight(index)}>
      <item.icon class="size-4 shrink-0 text-muted-foreground" />
      <span class="label">{item.label}</span>
      {#if item.hint}<span class="hint">{item.hint}</span>{/if}
    </Button>
  {/each}
</div>

<style>
  .picker {
    max-height: min(20rem, 40vh);
    overflow: auto;
    margin-bottom: 0.5rem;
    padding: var(--float-pad);
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    pointer-events: auto;
  }
  .floating { position: absolute; bottom: 100%; inset-inline-start: 0; width: min(100%, 30rem); z-index: 1; }
  .picker :global([role='option']) {
    display: flex;
    width: 100%;
    min-height: var(--float-row-h);
    align-items: center;
    justify-content: flex-start;
    gap: 0.625rem;
    padding: 0.3125rem 0.625rem;
    border-radius: var(--float-row-radius);
    font-size: var(--text-sm);
    text-align: left;
  }
  .picker :global([aria-selected='true']) { background: var(--float-row-hover); }
  .picker :global([aria-disabled='true']) { opacity: 0.45; cursor: default; }
  .label, .hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .floating .label { flex: 0 1 5rem; }
  .hint { font-size: var(--text-xs); color: var(--muted-foreground); }
</style>
