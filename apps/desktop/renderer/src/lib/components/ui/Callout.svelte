<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';
  let { title, text, tone = 'neutral', children, class: className = '' }: { title?: string; text?: string; tone?: 'neutral' | 'warning' | 'error'; children?: Snippet; class?: string } = $props();
</script>
<div class={cn('ui-notice', `tone-${tone}`, className)} role={tone === 'error' ? 'alert' : undefined}>
  {#if title}<p class="title"><span class="dot" aria-hidden="true"></span><span>{title}</span></p>{/if}
  {#if text}<p>{text}</p>{/if}
  {@render children?.()}
</div>
<style>
  .ui-notice { border:1px solid var(--float-border); border-radius:var(--float-radius); background:color-mix(in srgb, var(--foreground) 2.5%, transparent); padding:0.625rem 0.75rem; color:var(--muted-foreground); font-size:var(--text-sm); line-height:1.5; }
  .title { display:flex; align-items:center; gap:0.45rem; font-weight:500; color:var(--foreground); margin-bottom:0.25rem; }
  .dot { width:0.45rem; height:0.45rem; flex-shrink:0; border-radius:999px; background:var(--muted-foreground); }
  .tone-warning .dot { background:var(--warning); }
  .tone-error .dot { background:var(--error); }
</style>
