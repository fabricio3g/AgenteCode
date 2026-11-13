<script lang="ts">
  import { AlertCircle, LoaderCircle } from '$lib/icons';
  import type { HTMLAttributes } from 'svelte/elements';
  import Button from './Button.svelte';
  import { cn } from '$lib/utils/cn';
  let { loading = false, error, label, errorTitle, variant = 'inline', retry, retryLabel = 'Retry', class: className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { loading?: boolean; error?: string | null; label: string; errorTitle?: string; variant?: 'inline' | 'card'; retry?: () => void; retryLabel?: string } = $props();
</script>
{#if loading || error}
  <div class={cn('ui-async-state', variant === 'card' && 'is-card', error && !loading && 'is-error', className)} role={error && !loading ? 'alert' : 'status'} aria-live="polite" {...rest}>
    {#if loading}<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{:else}<AlertCircle class="size-4 shrink-0" aria-hidden="true" />{/if}
    <div>{#if error && !loading && errorTitle && variant === 'card'}<strong>{errorTitle}</strong>{/if}<span>{loading ? label : error}</span></div>
    {#if error && !loading && retry}<Button variant="outline" size="sm" onclick={retry}>{retryLabel}</Button>{/if}
  </div>
{/if}
<style>
  .ui-async-state { display:flex; align-items:center; justify-content:center; gap:0.5rem; padding:2rem 0; font-size:var(--text-sm); color:var(--muted-foreground); }
  .is-error { color:var(--error); }
  .is-card { align-items:flex-start; width:min(30rem,100%); margin:1rem auto; border-radius:var(--radius-lg); background:var(--surface-hover); padding:1rem; color:var(--text-secondary); text-align:left; }
  strong { display:block; margin-bottom:0.25rem; color:var(--foreground); font-size:var(--text-base); }
  span { line-height:1.5; }
  @media (prefers-reduced-motion:reduce) { .ui-async-state :global(.animate-spin) { animation:none; } }
</style>
