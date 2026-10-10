<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';
  let { title, text, tone = 'neutral', children, class: className = '' }: { title?: string; text?: string; tone?: 'neutral' | 'warning' | 'error'; children?: Snippet; class?: string } = $props();
</script>
<div class={cn('ui-notice', `tone-${tone}`, className)} role={tone === 'error' ? 'alert' : undefined}>
  {#if title}<p class="title">{title}</p>{/if}
  {#if text}<p>{text}</p>{/if}
  {@render children?.()}
</div>
<style>
  .ui-notice { border-inline-start:2px solid var(--border); padding-inline-start:0.75rem; color:var(--muted-foreground); font-size:var(--text-sm); line-height:1.5; }
  .title { font-weight:500; color:var(--foreground); margin-bottom:0.25rem; }
  .tone-warning { border-color:var(--warning); } .tone-error { border-color:var(--error); }
</style>
