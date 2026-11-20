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
  .ui-tab-bar { display:inline-flex; flex-shrink:0; min-width:0; max-width:100%; align-items:center; gap:2px; overflow-x:auto; overscroll-behavior:contain; scrollbar-width:thin; padding:2px; border:1px solid var(--border); border-radius:var(--radius-md); background:var(--muted); }
  :global(.ui-tab) { flex-shrink:0; max-width:12rem; min-height:1.625rem; padding:0.2rem 0.625rem; border:1px solid transparent; border-radius:var(--radius-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted-foreground); font-size:var(--text-xs); font-weight:500; transition:background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease); }
  :global(.ui-tab:hover) { background:color-mix(in srgb, var(--foreground) 6%, transparent); color:var(--foreground); }
  :global(.ui-tab[aria-selected="true"]) { border-color:var(--float-border); background:var(--composer-control-bg); box-shadow:var(--control-shadow); color:var(--foreground); font-weight:500; }
</style>
