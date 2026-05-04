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
  let userToggled = $state(false);

  const isCodeTool = $derived(name === 'run code' || name === 'run_code' || name === 'execute command' || name === 'execute_command');

  function toggle() {
    userToggled = true;
    open = !open;
  }

  $effect(() => {
    if (!userToggled) {
      open = status === 'error' || (status === 'running' && isCodeTool);
    }
  });

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
      <Code2 class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
    {:else}
      <Wrench class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
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
    <ChevronDown class={`h-3.5 w-3.5 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
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
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    overflow: hidden;
    margin-top: 0.1rem;
  }
  .tool-call-block.tool-call-code {
    border-color: transparent;
    background: transparent;
  }
  .tool-call-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.35rem 0.45rem;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.76rem;
    font-weight: 500;
    color: var(--text-secondary);
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  .tool-call-header:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  }
  .tool-name {
    flex: 1;
    text-align: left;
    font-family: var(--font-sans);
  }
  .tool-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: var(--radius-sm);
    font-size: 0.6875rem;
    font-weight: 500;
  }
  .tool-badge.done {
    color: var(--text-muted);
    background: transparent;
  }
  .tool-badge.running {
    color: var(--text-secondary);
    background: transparent;
  }
  .tool-badge.error {
    color: var(--error);
    background: transparent;
  }
  .tool-call-body {
    padding: 0.2rem 0.45rem 0.55rem 1.75rem;
    border-top: none;
  }
  .tool-call-body pre {
    margin: 0;
    font-size: 0.72rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    border-radius: var(--radius-sm);
    padding: 0.45rem 0;
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
    background: transparent;
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
    background: var(--code-terminal-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--code-terminal-text);
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
