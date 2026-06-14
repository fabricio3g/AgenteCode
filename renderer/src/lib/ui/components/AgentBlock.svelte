<svelte:options runes={true} />

<script lang="ts">
  import type { AgentActivity, AgentOutcome, AgentStopReason, ChatMessage } from '$lib/types/chat';
  import { Bot, Brain, ChevronRight, Loader, Globe, FileSearch, FilePen, Code2, Terminal, Eye, AlertCircle, Wrench, Zap } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  interface Props {
    steps?: ChatMessage['agentSteps'];
    reasoning?: string;
    status?: ChatMessage['status'];
    totalElapsedSeconds?: number;
    outcome?: AgentOutcome;
    stopReason?: AgentStopReason;
    currentActivity?: AgentActivity;
    activityLabel?: string;
    sourceCount?: number;
    messageId?: string;
  }

  let {
    steps = [],
    reasoning,
    status = 'idle',
    totalElapsedSeconds = 0,
    outcome = 'completed',
    stopReason = 'none',
    currentActivity,
    activityLabel,
    sourceCount = 0,
    messageId = ''
  }: Props = $props();

  const hasRunning = $derived(steps.some((s) => s.status === 'running'));
  const runningStep = $derived(steps.find((s) => s.status === 'running'));
  const errCount = $derived(steps.filter((s) => s.status === 'error').length);
  const doneCount = $derived(steps.filter((s) => s.status === 'done').length);
  const stoppedByUser = $derived(steps.some((s) => /stopped by user/i.test(s.detail || s.label || '')));

  const isThinking = $derived(status === 'streaming' && !steps.length && !reasoning);
  const hasRelevance = $derived(!!(steps.length || reasoning) || isThinking);

  function openActivity() {
    if (messageId) appStore.openActivityDrawer(messageId);
  }

  function formatThoughtDuration(seconds?: number | null): string | null {
    const safeSeconds = Number(seconds || 0);
    if (safeSeconds <= 0) return null;
    return `Worked for ${safeSeconds.toFixed(1)}s`;
  }

  function totalElapsedLabel(): string | null {
    const safeSeconds = Number(totalElapsedSeconds || 0);
    if (safeSeconds <= 0 || status === 'streaming') return null;
    if (outcome === 'failed') return `Failed after ${safeSeconds.toFixed(1)}s`;
    if (outcome === 'partial' || outcome === 'stopped' || stopReason !== 'none' || stoppedByUser) {
      return `Stopped after ${safeSeconds.toFixed(1)}s`;
    }
    return `Completed in ${safeSeconds.toFixed(1)}s`;
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

  function compactDetail(value?: string) {
    const clean = String(value || '')
      .replace(/^query:\s*/i, '')
      .replace(/^url:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return '';
    return clean.length > 92 ? `${clean.slice(0, 92)}…` : clean;
  }

  function activityText() {
    if (status === 'streaming' && runningStep) {
      const label = activityLabelFor(runningStep);
      const detail = compactDetail(runningStep.detail);
      return detail ? `${label}: ${detail}` : label;
    }
    return headerLabel();
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
    const thoughtDuration = formatThoughtDuration(totalElapsedSeconds);
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

  const headerIconStep = $derived(status === 'streaming' ? runningStep : null);
</script>

{#if hasRelevance}
  <div class="agent-block mb-4 w-full">
    <button type="button" class="agent-trigger" onclick={openActivity} aria-label="Open agent activity">
      {#if isThinking}
        <Loader class="h-4 w-4 shrink-0 animate-spin" />
      {:else if headerIconStep}
        {@const RunningIcon = stepIcon(headerIconStep.type)}
        <RunningIcon class="h-4 w-4 shrink-0" />
      {:else}
        <Bot class="h-4 w-4 shrink-0" />
      {/if}
      <span class="agent-trigger-text" class:text-shimmer={status === 'streaming'}>{activityText()}</span>
      <span class="agent-trigger-count">{steps.length || 1}</span>
      <ChevronRight class="h-4 w-4 shrink-0" />
    </button>

    {#if totalElapsedLabel()}
      <div class="agent-total">{totalElapsedLabel()}</div>
    {/if}
  </div>
{/if}

<style>
  .agent-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
    border-radius: 0.72rem;
    background: color-mix(in srgb, var(--surface) 86%, transparent);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 500;
    width: 100%;
    text-align: left;
    transition: color 0.15s ease;
  }
  .agent-trigger:hover {
    border-color: color-mix(in srgb, var(--primary) 22%, var(--border));
    background: color-mix(in srgb, var(--surface-hover) 80%, transparent);
    color: var(--text-secondary);
  }
  .agent-trigger-text {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-total {
    margin: 0.25rem 0 0 0.55rem;
    color: var(--text-tertiary);
    font-size: 0.68rem;
    font-weight: 450;
  }
  .agent-trigger-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.35rem;
    height: 1.15rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary) 9%, transparent);
    color: var(--text-muted);
    font-size: 0.66rem;
    font-weight: 700;
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
