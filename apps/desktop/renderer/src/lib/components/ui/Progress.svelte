<script lang="ts">
  import { cn } from '$lib/utils/cn';
  let { value, max = 100, label, class: className = '' }: { value?: number; max?: number; label: string; class?: string } = $props();
  const limit = $derived(Number.isFinite(max) && max > 0 ? max : 100);
  const bounded = $derived(value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(limit, value)));
</script>
<div class={cn('ui-progress', bounded === undefined && 'is-indeterminate', className)} role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax={limit} aria-valuenow={bounded}>
  <span style:width={bounded === undefined ? '30%' : `${bounded / limit * 100}%`}></span>
</div>
<style>
  .ui-progress { flex:1; min-width:0; height:0.3125rem; overflow:hidden; border-radius:var(--radius-full); background:var(--surface-hover); box-shadow:inset 0 1px 1px rgb(0 0 0 / 0.18); }
  span { display:block; height:100%; border-radius:inherit; background:var(--foreground); transition:width var(--motion-normal) var(--motion-ease-out); }
  .is-indeterminate span { animation:progress 1.2s ease-in-out infinite alternate; }
  @keyframes progress { to { transform:translateX(230%); } }
  @media (prefers-reduced-motion:reduce) { span { transition:none; } .is-indeterminate span { animation:none; margin-inline:auto; } }
</style>
