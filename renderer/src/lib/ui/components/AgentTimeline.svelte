<svelte:options runes={true} />

<script lang="ts">
  import type { ChatMessage } from '$lib/types/chat';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import {
    AlertCircle,
    Bot,
    Brain,
    CheckCircle2,
    ChevronDown,
    Code2,
    Eye,
    FileSearch,
    FilePen,
    Globe,
    Loader,
    Terminal,
    Wrench,
    Zap
  } from 'lucide-svelte';
  import ToolCallBlock from './ToolCallBlock.svelte';

  interface Props {
    steps?: ChatMessage['agentSteps'];
  }

  let { steps = [] }: Props = $props();
  let open = $state(true);
  let userToggled = $state(false);

  const hasRunning = $derived(steps.some((s) => s.status === 'running'));
  const errCount = $derived(steps.filter((s) => s.status === 'error').length);
  const doneCount = $derived(steps.filter((s) => s.status === 'done').length);

  $effect(() => {
    if (!userToggled) {
      open = hasRunning;
    }
  });

  function toggle() {
    userToggled = true;
    open = !open;
  }

  function label() {
    if (hasRunning) return 'Agent working…';
    if (errCount > 0) return `${doneCount} step${doneCount !== 1 ? 's' : ''} · ${errCount} error${errCount !== 1 ? 's' : ''}`;
    return `${doneCount} step${doneCount !== 1 ? 's' : ''} completed`;
  }

  function stepIcon(type: string) {
    switch (type) {
      case 'thinking':  return Brain;
      case 'searching': return Globe;
      case 'reading':   return FileSearch;
      case 'writing':   return FilePen;
      case 'coding':    return Code2;
      case 'executing': return Terminal;
      case 'preview':   return Eye;
      case 'error':     return AlertCircle;
      case 'tool':      return Wrench;
      default:          return Zap;
    }
  }

  function badgeLabel(step: NonNullable<ChatMessage['agentSteps']>[number]) {
    switch (step.status) {
      case 'done': return 'Done';
      case 'running': return 'Running';
      case 'error': return 'Error';
      default: return '';
    }
  }
</script>

{#if steps?.length}
  <div class="agent-block mb-4 w-full">
    <button class="steps-trigger" onclick={toggle}>
      <Bot class="h-4 w-4 shrink-0" />
      {#if hasRunning}
        <span class="steps-pulse-dot"></span>
      {/if}
      <span class="flex-1">{label()}</span>
      <ChevronDown class={`steps-chevron h-4 w-4 shrink-0 ${open ? 'open' : ''}`} />
    </button>

    {#if open}
      <div class="agent-steps" transition:slide={{ duration: 200, easing: quintOut }}>
        <div class="px-1 py-1.5">
          {#each steps as step, idx (step.id)}
            {@const Icon = step.status === 'running' ? Loader : stepIcon(step.type)}
            {@const isLast = idx === steps.length - 1}

            {#if step.type === 'tool'}
              <div class="step-row" class:last={isLast}>
                <ToolCallBlock
                  name={step.label}
                  status={step.status}
                  detail={step.detail}
                  output={step.output}
                />
              </div>
            {:else}
              <div class="step-row" class:last={isLast}>
                <!-- Track -->
                <div class="track">
                  <div class="dot-wrap" class:err={step.status === 'error'}>
                    <Icon class={`h-3 w-3 ${step.status === 'running' ? 'animate-spin' : ''}`} />
                  </div>
                  {#if !isLast}
                    <div class="connector"></div>
                  {/if}
                </div>
                <!-- Text -->
                <div class="content" class:last={isLast}>
                  <span class="step-label" class:muted={step.status === 'done'} class:running={step.status === 'running'} class:err={step.status === 'error'} class:shimmer={step.status === 'running' && isLast}>
                    {step.label}
                  </span>
                  {#if step.detail}
                    <span class="step-detail">{step.detail}</span>
                  {/if}
                  {#if step.output}
                    <details class="step-output">
                      <summary class="step-output-toggle">Output</summary>
                      <pre class="step-output-pre">{step.output}</pre>
                    </details>
                  {/if}
                  {#if !isLast}
                    <span class="step-badge" class:done={step.status === 'done'} class:running={step.status === 'running'} class:error={step.status === 'error'}>
                      {badgeLabel(step)}
                    </span>
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .steps-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    transition: color 0.15s ease;
  }
  .steps-trigger:hover {
    color: var(--text);
  }
  .steps-chevron {
    transition: transform 0.2s ease;
  }
  .steps-chevron.open {
    transform: rotate(180deg);
  }
  .steps-pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: cotPulse 1.5s ease-in-out infinite;
  }
  @keyframes cotPulse {
    0%, 100% {
      transform: scale(1);
      opacity: 0.6;
    }
    50% {
      transform: scale(1.4);
      opacity: 0.2;
    }
  }

  .agent-steps {
    padding: 0.25rem 0;
  }

  .step-row {
    display: flex;
    align-items: stretch;
    gap: 0.625rem;
    min-height: 1.75rem;
  }
  .step-row:last {
    margin-bottom: 0;
  }

  .track {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 1.125rem;
    flex-shrink: 0;
    padding-top: 0.2rem;
  }

  .dot-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 9999px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .dot-wrap.err {
    color: var(--error);
  }

  .connector {
    width: 2px;
    flex: 1;
    margin: 0.2rem 0;
    min-height: 0.375rem;
    background: var(--border);
    border-radius: 1px;
  }

  .content {
    flex: 1;
    min-width: 0;
    padding-bottom: 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    justify-content: center;
    position: relative;
  }
  .content:last {
    padding-bottom: 0;
  }

  .step-label {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.375rem;
  }
  .step-label.muted {
    color: var(--text-tertiary);
    font-weight: 400;
  }
  .step-label.err {
    color: var(--error);
  }
  .step-label.running {
    color: var(--text);
  }
  .step-label.shimmer {
    background: linear-gradient(90deg, var(--text) 40%, var(--text-muted) 60%, var(--text) 80%);
    background-size: 200% auto;
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: textShimmer 3s linear infinite;
  }

  .step-detail {
    font-size: 0.6875rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .step-badge {
    display: inline-flex;
    align-items: center;
    margin-left: auto;
    padding: 0 0.375rem;
    border-radius: 9999px;
    font-size: 0.625rem;
    font-weight: 500;
    line-height: 1.25rem;
    width: fit-content;
  }
  .step-badge.done {
    background: var(--success-bg);
    color: var(--success);
  }
  .step-badge.running {
    background: var(--info-bg);
    color: var(--info);
  }
  .step-badge.error {
    background: var(--error-bg);
    color: var(--error);
  }

  .step-output {
    margin-top: 0.25rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--surface);
    overflow: hidden;
  }
  .step-output-toggle {
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }
  .step-output-toggle:hover {
    color: var(--text);
  }
  .step-output-pre {
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    border-top: 1px solid var(--border);
    max-height: 16rem;
    overflow: auto;
  }
</style>
