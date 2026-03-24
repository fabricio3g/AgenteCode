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
    ChevronUp,
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
  import MorphingHexagon from './MorphingHexagon.svelte';

  interface Props {
    steps?: ChatMessage['agentSteps'];
    managed?: boolean;
  }

  let { steps = [], managed = false }: Props = $props();
  let open = $state(true);
  let userToggled = $state(false);

  const hasRunning = $derived(steps.some((s) => s.status === 'running'));
  const errCount = $derived(steps.filter((s) => s.status === 'error').length);
  const doneCount = $derived(steps.filter((s) => s.status === 'done').length);

  // Auto-open while running, collapse when done (unless user already toggled)
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
</script>

{#if steps?.length}
  <div class="agent-block mb-4 w-full">
    <!-- Toggle header — identical pattern to ReasoningBlock -->
    <button class="agent-toggle flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition" onclick={toggle}>
      <Bot class={`h-4 w-4 shrink-0 ${hasRunning ? 'animate-pulse' : ''}`} />
      <span class="flex-1 text-sm font-medium">{label()}</span>
      {#if hasRunning}
        <MorphingHexagon size={16} />
      {/if}
      {#if open}
        <ChevronUp class="h-4 w-4 shrink-0 opacity-50" />
      {:else}
        <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
      {/if}
    </button>

    {#if open}
      <div class="agent-steps mt-1 overflow-hidden rounded-xl" transition:slide={{ duration: 200, easing: quintOut }}>
        <div class="px-3 py-2.5">
          {#each steps as step, idx (step.id)}
            {@const Icon = step.status === 'running' ? Loader : stepIcon(step.type)}
            {@const isLast = idx === steps.length - 1}
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
                <span class="step-label" class:muted={step.status === 'done'} class:running={step.status === 'running' && isLast} class:err={step.status === 'error'}>
                  {step.label}
                </span>
                {#if step.detail}
                  <span class="step-detail">{step.detail}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ── Outer card — same as ReasoningBlock ─────────────── */
  .agent-toggle {
    color: var(--text-secondary);
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .agent-toggle:hover {
    background: var(--surface-highlight);
  }

  .agent-steps {
    background: var(--surface-highlight);
    border: 1px solid var(--border);
  }

  /* ── Step rows ───────────────────────────────────────── */
  .step-row {
    display: flex;
    align-items: stretch;
    gap: 0.625rem;
    min-height: 1.75rem;
  }

  /* Track column: dot + vertical line */
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
    width: 1px;
    flex: 1;
    margin: 0.2rem 0;
    min-height: 0.375rem;
    background: var(--border);
  }

  /* Content column */
  .content {
    flex: 1;
    min-width: 0;
    padding-bottom: 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    justify-content: center;
  }
  .content.last {
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

  .step-detail {
    font-size: 0.6875rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

</style>
