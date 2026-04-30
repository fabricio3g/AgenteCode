<svelte:options runes={true} />

<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { Wrench, ChevronDown, Loader2, CheckCircle2, AlertCircle, Terminal, Code2 } from 'lucide-svelte';

  interface Props {
    name: string;
    status?: 'done' | 'running' | 'error' | 'pending' | 'awaiting_approval';
    detail?: string;
    output?: string;
  }

  let { name, status = 'running', detail, output }: Props = $props();
  let open = $state(false);

  const isCodeTool = $derived(name === 'run code' || name === 'run_code' || name === 'execute command' || name === 'execute_command');

  function toggle() {
    open = !open;
  }

  function titleCase(snake: string): string {
    return snake
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const displayName = $derived(titleCase(name));
</script>

<div class="tool-call-block" class:tool-call-code={isCodeTool}>
  <button class="tool-call-header" onclick={toggle}>
    {#if isCodeTool}
      <Code2 class="tool-wrench h-3.5 w-3.5 shrink-0" />
    {:else}
      <Wrench class="tool-wrench h-3.5 w-3.5 shrink-0" />
    {/if}
    <span class="tool-name">{displayName}</span>
    <span class="tool-badge" class:done={status === 'done'} class:running={status === 'running'} class:error={status === 'error'}>
      {#if status === 'running'}
        <Loader2 class="h-3 w-3 animate-spin" />
      {:else if status === 'done'}
        <CheckCircle2 class="h-3 w-3" />
      {:else}
        <AlertCircle class="h-3 w-3" />
      {/if}
    </span>
    <ChevronDown class={`tool-chevron h-3.5 w-3.5 ${open ? 'open' : ''}`} />
  </button>

  {#if open && (detail || output)}
    <div class="tool-call-body" transition:slide={{ duration: 150, easing: quintOut }}>
      {#if detail && !isCodeTool}
        <div class="tool-section">
          <div class="tool-section-label">Arguments</div>
          <pre>{detail}</pre>
        </div>
      {/if}
      {#if output}
        <div class="tool-section" class:has-gap={!!detail && !isCodeTool}>
          <div class="tool-section-label">
            {#if isCodeTool}
              <div class="terminal-header">
                <Terminal class="h-3 w-3" />
                <span>Output</span>
              </div>
            {:else}
              Result
            {/if}
          </div>
          <pre class:tool-output={!isCodeTool} class:terminal-output={isCodeTool}>{output}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-call-block {
    width: 100%;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--surface);
    overflow: hidden;
    margin-top: 0.75rem;
  }
  .tool-call-block.tool-call-code {
    border-color: var(--border);
    background: var(--surface);
  }
  .tool-call-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-secondary);
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .tool-call-header:hover {
    color: var(--text);
    background: var(--surface-hover);
  }
  .tool-wrench {
    color: var(--text-muted);
  }
  .tool-name {
    flex: 1;
    text-align: left;
    font-family: var(--font-mono);
  }
  .tool-chevron {
    transition: transform 0.2s ease;
    color: var(--text-muted);
  }
  .tool-chevron.open {
    transform: rotate(180deg);
  }
  .tool-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-full);
    font-size: 0.6875rem;
    font-weight: 500;
  }
  .tool-badge.done {
    color: var(--accent-green-text);
    background: var(--accent-green-bg);
  }
  .tool-badge.running {
    color: var(--accent-blue-text);
    background: var(--accent-blue-bg);
  }
  .tool-badge.error {
    color: var(--accent-red-text);
    background: var(--accent-red-bg);
  }
  .tool-call-body {
    padding: 0.5rem 0.75rem 0.75rem;
    border-top: 1px solid var(--border);
  }
  .tool-call-body pre {
    margin: 0;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    background: transparent;
    border-radius: var(--radius-sm);
    padding: 0.5rem;
    line-height: 1.5;
  }
  .tool-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .tool-section.has-gap {
    margin-top: 0.75rem;
  }
  .tool-section-label {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .tool-output {
    background: var(--surface-hover);
    border-radius: var(--radius-sm);
    max-height: 18rem;
    overflow: auto;
  }
  .terminal-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-bottom: 0.25rem;
  }
  .terminal-output {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: var(--radius-sm);
    color: #e6edf3;
    max-height: 20rem;
    overflow: auto;
    font-size: 0.75rem;
    line-height: 1.5;
    padding: 0.625rem 0.75rem;
    font-family: var(--font-mono);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
