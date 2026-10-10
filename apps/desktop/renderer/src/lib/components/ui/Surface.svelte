<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  type Props = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'aside' | 'header'; tone?: 'plain' | 'quiet' | 'raised' | 'danger'; padding?: 'none' | 'sm' | 'md'; scroll?: boolean; ref?: HTMLElement };
  let { as = 'div', tone = 'quiet', padding = 'md', scroll = false, ref = $bindable(), class: className = '', children, ...rest }: Props = $props();
</script>
<svelte:element this={as} bind:this={ref} class={cn('ui-surface', `tone-${tone}`, `padding-${padding}`, scroll && 'is-scroll', className)} {...rest}>
  {@render children?.()}
</svelte:element>
<style>
  .ui-surface { min-width:0; min-height:0; border:0; border-radius:var(--float-radius); }
  .tone-plain { background:transparent; }
  .tone-quiet { background:color-mix(in srgb, var(--foreground) 2.5%, transparent); }
  .tone-raised { background:var(--card); box-shadow:var(--control-shadow); }
  .tone-danger { background:var(--error-bg); }
  .padding-none { padding:0; } .padding-sm { padding:0.5rem; } .padding-md { padding:1rem; }
  .is-scroll { overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
</style>
