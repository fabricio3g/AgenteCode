<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import Button from './Button.svelte';
  import { cn } from '$lib/utils/cn';
  export type TabOption = { value: string; label: string; title?: string; disabled?: boolean; panelId?: string };
  let { value = $bindable(''), options, label, onchange, class: className = '', ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'onchange'> & { value?: string; options: TabOption[]; label: string; onchange?: (value: string) => void } = $props();
  function choose(next: string) { value = next; onchange?.(next); }
  function navigate(event: KeyboardEvent, index: number) {
    if (!options.length) return;
    let next = index;
    const backward = event.key === 'ArrowLeft' || event.key === 'End';
    if (event.key === 'ArrowRight') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    for (let count = 0; count < options.length; count++) {
      if (!options[next].disabled) {
        choose(options[next].value);
        const button = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
        button?.focus(); button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        return;
      }
      next = (next + (backward ? -1 : 1) + options.length) % options.length;
    }
  }
</script>
<div class={cn('ui-tab-bar', className)} role="tablist" aria-label={label} {...rest}>
  {#each options as option, index (option.value)}
    <Button variant="plain" role="tab" aria-selected={value === option.value} aria-controls={option.panelId} tabindex={value === option.value || (!options.some(o => o.value === value && !o.disabled) && index === options.findIndex(o => !o.disabled)) ? 0 : -1} disabled={option.disabled} title={option.title || option.label} class="ui-tab" onclick={() => choose(option.value)} onkeydown={event => navigate(event, index)}>{option.label}</Button>
  {/each}
</div>
<style>
  .ui-tab-bar { display:flex; flex-shrink:0; min-width:0; align-items:center; gap:0.25rem; overflow-x:auto; overscroll-behavior:contain; scrollbar-width:thin; padding:0.25rem; }
  :global(.ui-tab) { flex-shrink:0; max-width:12rem; min-height:1.75rem; padding:0.25rem 0.625rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted-foreground); font-size:var(--text-xs); }
  :global(.ui-tab:hover), :global(.ui-tab[aria-selected="true"]) { background:var(--surface-hover); color:var(--foreground); }
</style>
