<script lang="ts">
  import { Cpu, Server } from 'lucide-svelte';

  let { provider, size = 20 }: { provider: string; size?: number } = $props();
  const brands = new Set(['opencode-go', 'openrouter', 'deepseek', 'lmstudio', 'ollama']);
</script>

<span class="provider-icon" style:width={`${size}px`} style:height={`${size}px`} aria-hidden="true">
  {#if brands.has(provider)}
    <span class="brand" style:mask-image={`url('/providers/${provider}.svg')`}></span>
  {:else if provider === 'local'}
    <Cpu size={size} />
  {:else}
    <Server size={size} />
  {/if}
</span>

<style>
  .provider-icon { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; }
  .brand { width: 100%; height: 100%; background: currentColor; mask-size: contain; mask-repeat: no-repeat; mask-position: center; }
</style>
