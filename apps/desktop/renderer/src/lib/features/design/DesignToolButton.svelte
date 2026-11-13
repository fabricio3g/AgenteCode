<svelte:options runes={true} />

<!--
  An icon-only canvas control: the app's IconButton behind its shortcut tooltip.
  With `pressed` it is a toggle, drawn with the same soft accent tint as the
  Code pane strip's open panes.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Icon as AppIcon } from '$lib/icons';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { cn } from '$lib/utils/cn';

  let {
    icon: Icon,
    label,
    shortcut,
    pressed,
    position = 'bottom',
    class: className = '',
    onclick,
    children
  }: {
    icon: AppIcon;
    label: string;
    shortcut?: string;
    /** Set for a toggle: the button reports its state and takes the on tint. */
    pressed?: boolean;
    position?: 'top' | 'bottom';
    class?: string;
    onclick: (event: MouseEvent) => void;
    children?: Snippet;
  } = $props();
</script>

<Tooltip {label} {shortcut} {position}>
  <IconButton {label} title="" class={cn('design-tool', pressed && 'is-on', className)} aria-pressed={pressed} {onclick}>
    <Icon aria-hidden="true" />
    {@render children?.()}
  </IconButton>
</Tooltip>

<style>
  :global(.design-tool.is-on) {
    background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
    color: var(--foreground);
  }
</style>
