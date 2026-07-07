<svelte:options runes={true} />

<script lang="ts">
  import { Terminal, FilePen, FileSearch, Globe, Eye, Bot, Loader2 } from 'lucide-svelte';
  import type { AgentStep } from '$lib/types/chat';

  interface Props { step: AgentStep }

  let { step }: Props = $props();
  let expanded = $state(false);

  const Icon = $derived(icon(step));
  const heading = $derived(step.label || step.type);
  const preview = $derived((step.detail || '').replace(/\s+/g, ' ').trim().slice(0, 160));
  const hasOutput = $derived(!!(step.output || ''));
  const adds = $derived(step.diffStats?.reduce((s, d) => s + d.additions, 0) || 0);
  const dels = $derived(step.diffStats?.reduce((s, d) => s + d.deletions, 0) || 0);

  function icon(s: AgentStep) {
    if (s.type === 'executing' || /bash|shell|command|terminal/i.test(s.label)) return Terminal;
    if (s.type === 'writing' || /write|create|file/i.test(s.label)) return FilePen;
    if (s.type === 'reading' || /read|fetch/i.test(s.label)) return FileSearch;
    if (s.type === 'searching' || /search|grep|find/i.test(s.label)) return Globe;
    if (s.type === 'preview' || /preview|view/i.test(s.label)) return Eye;
    if (s.type === 'thinking' || s.type === 'planning') return Bot;
    return Terminal;
  }
</script>

<div
  class="row"
  class:runnable={hasOutput}
  class:running={step.status === 'running'}
  class:error={step.status === 'error'}
  onclick={() => { if (hasOutput) expanded = !expanded; }}
  onkeydown={(e) => { if (hasOutput && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); expanded = !expanded; }}}
  role={hasOutput ? 'button' : undefined}
  tabindex={hasOutput ? 0 : undefined}
>
  {#if step.status === 'running'}
    <Loader2 class="icon spin" />
  {:else}
    <Icon class="icon" />
  {/if}
  <span class="label">{heading}</span>
  {#if preview}
    <span class="detail">{preview}</span>
  {/if}
  <span class="trail">
    {#if adds || dels}
      <span class="adds">+{adds}</span>
      <span class="dels">-{dels}</span>
    {/if}
  </span>
</div>
{#if expanded && hasOutput}
  <pre class="body">{step.output!.slice(0, 6000)}{step.output!.length > 6000 ? '\n... (truncated)' : ''}</pre>
{/if}

<style>
  .row {
    display: flex; align-items: center; gap: 0.35rem;
    padding: 0.2rem 0.4rem; font-size: 0.74rem; line-height: 1.4;
    border-radius: 0.35rem; transition: background 0.1s;
  }
  .row.runnable { cursor: pointer; }
  .row:hover { background: color-mix(in srgb, var(--surface-hover) 40%, transparent); }
  .row.running .icon { color: var(--primary); animation: spin 1s linear infinite; }
  .row.error .label { color: var(--error); }
  .icon { width: 1rem; height: 1rem; flex-shrink: 0; color: var(--text-muted); }
  .label { font-weight: 600; color: var(--text-secondary); white-space: nowrap; flex-shrink: 0; }
  .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 0.7rem; }
  .trail { margin-left: auto; display: flex; gap: 0.25rem; flex-shrink: 0; font-family: var(--font-mono); font-size: 0.68rem; font-weight: 720; }
  .adds { color: #16a34a; }
  .dels { color: #dc2626; }
  .body {
    margin: 0; padding: 0.35rem 0.5rem; max-height: 14rem; overflow: auto;
    border-top: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    color: var(--text-secondary); font-family: var(--font-mono); font-size: 0.68rem;
    line-height: 1.5; white-space: pre-wrap;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
