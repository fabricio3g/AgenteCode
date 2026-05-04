<svelte:options runes={true} />

<script lang="ts">
  import type { AgentActivity, AgentOutcome, AgentStopReason, ChatMessage } from '$lib/types/chat';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { Bot, Brain, ChevronDown, Loader, Globe, FileSearch, FilePen, Code2, Terminal, Eye, AlertCircle, Wrench, Zap } from 'lucide-svelte';
  import ToolCallBlock from './ToolCallBlock.svelte';

  interface Props {
    steps?: ChatMessage['agentSteps'];
    reasoning?: string;
    status?: ChatMessage['status'];
    timing?: number;
    outcome?: AgentOutcome;
    stopReason?: AgentStopReason;
    currentActivity?: AgentActivity;
    activityLabel?: string;
    sourceCount?: number;
  }

  let {
    steps = [],
    reasoning,
    status = 'idle',
    timing = 0,
    outcome = 'completed',
    stopReason = 'none',
    currentActivity,
    activityLabel,
    sourceCount = 0
  }: Props = $props();
  let open = $state(false);
  let userToggled = $state(false);

  const hasRunning = $derived(steps.some((s) => s.status === 'running'));
  const runningStep = $derived(steps.find((s) => s.status === 'running'));
  const errCount = $derived(steps.filter((s) => s.status === 'error').length);
  const doneCount = $derived(steps.filter((s) => s.status === 'done').length);
  const stoppedByUser = $derived(steps.some((s) => /stopped by user/i.test(s.detail || s.label || '')));
  const filteredSteps = $derived(steps.filter((s) => !(s.status === 'running' && s.type === 'thinking')));
  const relevantSteps = $derived(steps.filter((s) => !(s.type === 'thinking' && s.status === 'running' && s.label === 'Planning')));
  const latestInlineSteps = $derived(relevantSteps.slice(-2));

  const isThinking = $derived(status === 'streaming' && !steps.length && !reasoning);
  const hasRelevance = $derived(!!(steps.length || reasoning) || isThinking);

  function toggle() {
    userToggled = true;
    open = !open;
  }

  function formatThoughtDuration(seconds?: number | null): string | null {
    const safeSeconds = Number(seconds || 0);
    if (safeSeconds <= 0) return null;
    return `Worked for ${safeSeconds.toFixed(1)}s`;
  }

  function activityLabelFor(step?: NonNullable<ChatMessage['agentSteps']>[number] | null): string {
    if (!step) {
      if (activityLabel) return activityLabel;
      switch (currentActivity) {
        case 'searching': return 'Searching the web';
        case 'reading': return 'Reading sources';
        case 'creating_files': return 'Creating files';
        case 'writing': return 'Writing answer';
        case 'stopped': return 'Agent stopped';
        case 'completed': return 'Agent finished';
        default: return 'Agent is planning';
      }
    }
    const label = step.label.toLowerCase();
    if (step.type === 'searching' || label.includes('search')) return 'Searching the web';
    if (step.type === 'reading' || label.includes('fetch') || label.includes('read') || label.includes('source')) return 'Reading sources';
    if (step.type === 'writing' || label.includes('document') || label.includes('spreadsheet') || label.includes('presentation') || label.includes('pdf') || label.includes('file')) return 'Creating files';
    if (label.includes('answer') || label.includes('response')) return 'Writing answer';
    if (step.type === 'thinking' || step.type === 'planning') return 'Agent is planning';
    return activityLabel || step.label || 'Agent is working';
  }

  function liveLabel() {
    const label = activityLabel || activityLabelFor(runningStep);
    const count = doneCount + (hasRunning ? 1 : 0);
    return count > 0 ? `${label} · ${count} step${count !== 1 ? 's' : ''}` : label;
  }

  function headerLabel() {
    if (status === 'streaming') return liveLabel();
    if (stoppedByUser) return 'Agent stopped by user';
    if (steps.length) {
      if (outcome === 'failed') return 'Agent failed';
      if (outcome === 'partial' || outcome === 'stopped' || stopReason !== 'none') {
        const kept = sourceCount ? ` · ${sourceCount} source${sourceCount !== 1 ? 's' : ''} kept` : '';
        switch (stopReason) {
          case 'timeout': return `Agent stopped · timed out${kept}`;
          case 'loop': return `Agent stopped · loop detected${kept}`;
          case 'tool_limit': return `Agent stopped · tool limit reached${kept}`;
          case 'iteration_limit': return `Agent stopped · iteration limit reached${kept}`;
          case 'missing_artifacts': return 'Agent stopped · missing requested files';
          case 'error': return `Agent stopped${kept}`;
          default: return `Agent stopped${kept}`;
        }
      }
      const parts: string[] = [];
      if (doneCount) parts.push(`${doneCount} step${doneCount !== 1 ? 's' : ''}`);
      if (errCount) parts.push(`${errCount} error${errCount !== 1 ? 's' : ''}`);
      return parts.length ? `Agent finished · ${parts.join(' · ')}` : 'Agent finished';
    }
    const thoughtDuration = formatThoughtDuration(timing);
    if (thoughtDuration) return thoughtDuration;
    if (reasoning) return 'Reasoning';
    return activityLabel || 'Agent is planning';
  }

  function stepIcon(type: string) {
    switch (type) {
      case 'thinking': return Brain;
      case 'searching': return Globe;
      case 'reading': return FileSearch;
      case 'writing': return FilePen;
      case 'coding': return Code2;
      case 'executing': return Terminal;
      case 'preview': return Eye;
      case 'error': return AlertCircle;
      case 'tool': return Wrench;
      default: return Zap;
    }
  }

  const TOOL_TYPES = new Set(['tool', 'writing', 'reading', 'searching', 'preview', 'coding', 'executing']);
  const headerIconStep = $derived(status === 'streaming' ? runningStep : null);

  $effect(() => {
    if (!userToggled) {
      open = status === 'streaming' || hasRunning;
    }
  });
</script>

{#if hasRelevance}
  <div class="agent-block mb-4 w-full">
    <button type="button" class="agent-trigger" onclick={toggle}>
      {#if isThinking}
        <Loader class="h-4 w-4 shrink-0 animate-spin" />
      {:else if headerIconStep}
        {@const RunningIcon = stepIcon(headerIconStep.type)}
        <RunningIcon class="h-4 w-4 shrink-0" />
      {:else}
        <Bot class="h-4 w-4 shrink-0" />
      {/if}
      <span class="flex-1" class:text-shimmer={status === 'streaming'}>{headerLabel()}</span>
      <ChevronDown class={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>

    {#if status === 'streaming' && latestInlineSteps.length}
      <div class="agent-inline-steps">
        {#each latestInlineSteps as step (step.id)}
          {@const Icon = step.status === 'running' ? Loader : stepIcon(step.type)}
          <div class="agent-inline-step" class:active={step.status === 'running'}>
            <Icon class={`h-3 w-3 shrink-0 ${step.status === 'running' ? 'animate-spin' : ''}`} />
            <span>{activityLabelFor(step)}</span>
          </div>
        {/each}
      </div>
    {/if}

    {#if open}
      <div class="agent-content" transition:slide={{ duration: 150, easing: quintOut }}>
        <div class="agent-bar"></div>
        <div class="agent-steps-list">
          {#if filteredSteps.length}
            {#each filteredSteps as step (step.id)}
              {@const Icon = step.status === 'running' ? Loader : stepIcon(step.type)}

              {#if TOOL_TYPES.has(step.type)}
                <div class="agent-step-item">
                  <ToolCallBlock
                    name={step.label}
                    status={step.status}
                    detail={step.detail}
                    output={step.output}
                  />
                </div>
              {:else}
                <div class="agent-step-item">
                  <div class="step-header">
                    <Icon class={`h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)] ${step.status === 'running' ? 'animate-spin' : ''}`} />
                    <span class="step-label" class:muted={step.status === 'done'} class:err={step.status === 'error'}>{step.label}</span>
                  </div>
                  {#if step.detail}
                    <div class="step-detail">{step.detail}</div>
                  {/if}
                  {#if step.output}
                    <details class="step-output">
                      <summary class="step-output-toggle">Output</summary>
                      <pre class="step-output-pre">{step.output}</pre>
                    </details>
                  {/if}
                </div>
              {/if}
            {/each}
          {/if}

          {#if reasoning}
            <div class="reasoning-section">
              <div class="reasoning-text">{reasoning}</div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .agent-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    width: 100%;
    text-align: left;
    transition: color 0.15s ease;
  }
  .agent-trigger:hover {
    color: var(--text-secondary);
  }
  .agent-inline-steps {
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
    margin: 0.15rem 0 0.25rem 1.55rem;
  }
  .agent-inline-step {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    width: fit-content;
    max-width: 100%;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--text-tertiary);
    opacity: 0.82;
  }
  .agent-inline-step.active {
    color: var(--text-secondary);
    opacity: 1;
  }
  .agent-content {
    display: grid;
    grid-template-columns: 1px 1fr;
    gap: 0.65rem;
    padding-top: 0.35rem;
    overflow: hidden;
  }
  .agent-bar {
    width: 1px;
    background: var(--border);
  }
  .agent-steps-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .agent-step-item {
    padding-bottom: 0.1rem;
  }
  .step-header {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .step-label {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .step-label.muted {
    color: var(--text-tertiary);
    font-weight: 400;
  }
  .step-label.err {
    color: var(--error);
  }
  .step-detail {
    font-size: 0.72rem;
    color: var(--text-muted);
    padding-top: 0.125rem;
  }
  .step-output {
    margin-top: 0.25rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    overflow: hidden;
  }
  .step-output-toggle {
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
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
  .reasoning-section {
    padding-top: 0.35rem;
    margin-top: 0.25rem;
    border-top: 1px solid var(--border);
  }
  .reasoning-text {
    color: var(--text-tertiary);
    font-size: 0.78rem;
    line-height: 1.65;
    white-space: pre-wrap;
  }

  .text-shimmer {
    background: linear-gradient(90deg, var(--text-muted) 40%, var(--text-secondary) 60%, var(--text-muted) 80%);
    background-size: 200% auto;
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: shimmer 3s linear infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 50%; }
    100% { background-position: -200% 50%; }
  }
</style>
