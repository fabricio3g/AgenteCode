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
  <div class="agent-block mb-2 w-full">
    <button type="button" class="agent-trigger" onclick={openActivity} aria-label="Open agent activity">
      {#if isThinking || status === 'streaming'}
        <Loader class="size-4 shrink-0 animate-spin" style="animation-duration: 0.6s" />
      {:else if headerIconStep}
        {@const RunningIcon = stepIcon(headerIconStep.type)}
        <RunningIcon class="size-4 shrink-0" />
      {:else}
        <Bot class="size-4 shrink-0" />
      {/if}
      <span class="agent-trigger-text aui-shimmer-host">
        <span>{activityText()}</span>
        {#if status === 'streaming'}
          <span class="aui-shimmer" aria-hidden="true">{activityText()}</span>
        {/if}
      </span>
      {#if steps.length}
        <span class="agent-trigger-count">{steps.length}</span>
      {/if}
      <ChevronRight class="size-4 shrink-0 opacity-70" />
    </button>

    {#if totalElapsedLabel()}
      <div class="agent-total">{totalElapsedLabel()}</div>
    {/if}
  </div>
{/if}

<style>
  .agent-trigger {
    display: flex;
    max-width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    width: fit-content;
    max-width: 100%;
    text-align: left;
    transition: color 150ms ease, transform 150ms var(--motion-ease);
  }
  .agent-trigger:hover {
    color: var(--foreground);
  }
  .agent-trigger:active {
    transform: scale(0.98);
  }
  .agent-trigger-text {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-total {
    margin: 0.15rem 0 0 1.5rem;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    font-weight: 450;
    opacity: 0.8;
  }
  .agent-trigger-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.1rem;
    border-radius: 999px;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 0.65rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
</style>
