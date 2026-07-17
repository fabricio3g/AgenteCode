<svelte:options runes={true} />

<script lang="ts">
  import type { AgentActivity, AgentOutcome, AgentStopReason, ChatMessage } from '$lib/types/chat';
  import { Check } from 'lucide-svelte';
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
    /** When deep/max search is active, show a quiet mode chip */
    searchMode?: 'chat' | 'search' | 'deep' | 'max' | null;
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
    messageId = '',
    searchMode = null
  }: Props = $props();

  const modeChip = $derived(
    searchMode === 'deep' ? 'Deep' : searchMode === 'max' ? 'Max' : searchMode === 'search' ? 'Search' : ''
  );

  const errCount = $derived(steps.filter((s) => s.status === 'error').length);
  const doneCount = $derived(steps.filter((s) => s.status === 'done').length);
  const hasApproval = $derived(steps.some((s) => s.status === 'awaiting_approval'));
  const stoppedByUser = $derived(steps.some((s) => /stopped by user/i.test(s.detail || s.label || '')));
  const isStreaming = $derived(status === 'streaming');
  const hasRelevance = $derived(!!(steps.length || reasoning) || isStreaming);

  /** Debounced short label so progress ticks don't thrash the line. */
  let stableVerb = $state('Working');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let streamStartedAt = $state<number | null>(null);
  let liveElapsed = $state(0);
  let liveTimer: ReturnType<typeof setInterval> | null = null;

  function shortVerb(activity?: AgentActivity | null, label?: string | null): string {
    const raw = String(label || '').toLowerCase();
    if (activity === 'searching' || raw.includes('search')) return 'Searching';
    if (activity === 'reading' || raw.includes('read') || raw.includes('fetch') || raw.includes('source')) return 'Reading';
    if (activity === 'creating_files' || raw.includes('file') || raw.includes('document') || raw.includes('artifact')) return 'Writing';
    if (activity === 'writing' || raw.includes('answer') || raw.includes('response')) return 'Writing';
    if (activity === 'stopped') return 'Stopped';
    if (activity === 'completed') return 'Done';
    if (raw.includes('plan') || raw.includes('think')) return 'Working';
    return 'Working';
  }

  $effect(() => {
    if (!isStreaming) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      return;
    }
    const next = shortVerb(currentActivity, activityLabel);
    if (next === stableVerb) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      stableVerb = next;
      debounceTimer = null;
    }, 400);
    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  // Seed immediately on first stream so we don't wait 400ms for first paint
  $effect(() => {
    if (isStreaming && stableVerb === 'Working') {
      const next = shortVerb(currentActivity, activityLabel);
      if (next !== 'Working') stableVerb = next;
    }
  });

  $effect(() => {
    if (isStreaming) {
      if (streamStartedAt == null) streamStartedAt = Date.now();
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = setInterval(() => {
        if (streamStartedAt != null) liveElapsed = (Date.now() - streamStartedAt) / 1000;
      }, 250);
      liveElapsed = streamStartedAt != null ? (Date.now() - streamStartedAt) / 1000 : 0;
    } else {
      streamStartedAt = null;
      liveElapsed = 0;
      if (liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    }
    return () => {
      if (liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    };
  });

  function openActivity() {
    if (messageId) appStore.openActivityDrawer(messageId);
  }

  function elapsedLive(): string {
    const s = isStreaming ? liveElapsed : Number(totalElapsedSeconds || 0);
    if (!Number.isFinite(s) || s < 0.5) return '';
    if (s < 10) return `${s.toFixed(1)}s`;
    return `${Math.floor(s)}s`;
  }

  const line = $derived.by(() => {
    if (isStreaming) {
      if (hasApproval) return 'Needs approval';
      const t = elapsedLive();
      const core = t ? `${stableVerb} · ${t}` : stableVerb;
      return modeChip ? `${modeChip} · ${core}` : core;
    }

    if (stoppedByUser) return 'Stopped';
    if (outcome === 'failed') {
      const s = Number(totalElapsedSeconds || 0);
      return s > 0 ? `Failed · ${s.toFixed(1)}s` : 'Failed';
    }
    if (outcome === 'partial' || outcome === 'stopped' || stopReason !== 'none') {
      const s = Number(totalElapsedSeconds || 0);
      const time = s > 0 ? ` · ${s.toFixed(1)}s` : '';
      return `Stopped${time}`;
    }

    if (steps.length) {
      const parts: string[] = [];
      if (doneCount) parts.push(`${doneCount} step${doneCount === 1 ? '' : 's'}`);
      if (errCount) parts.push(`${errCount} error${errCount === 1 ? '' : 's'}`);
      const s = Number(totalElapsedSeconds || 0);
      if (s > 0) parts.push(`${s.toFixed(1)}s`);
      if (sourceCount > 0) parts.push(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`);
      return parts.length ? parts.join(' · ') : 'Done';
    }

    const s = Number(totalElapsedSeconds || 0);
    if (s > 0) return `${s.toFixed(1)}s`;
    if (reasoning) return 'Reasoning';
    return 'Done';
  });
</script>

{#if hasRelevance}
  <div class="agent-status">
    <button type="button" class="agent-line" onclick={openActivity} aria-label="Open agent activity">
      {#if isStreaming}
        <span class="agent-line-text aui-shimmer-host">
          <span>{line}</span>
          <span class="aui-shimmer" aria-hidden="true">{line}</span>
        </span>
      {:else}
        {#if errCount}
          <span class="status-dot error" aria-hidden="true"></span>
        {:else}
          <span class="status-icon done" aria-hidden="true">
            <Check class="size-3.5" />
          </span>
        {/if}
        <span class="agent-line-text">{line}</span>
      {/if}
    </button>
  </div>
{/if}

<style>
  .agent-status {
    margin-bottom: 0.35rem;
    width: 100%;
  }

  .agent-line {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    text-align: left;
    transition: color 150ms ease;
  }

  .agent-line:hover {
    color: var(--foreground);
  }

  .agent-line:focus-visible {
    outline: none;
    box-shadow: var(--artifact-focus, 0 0 0 2px color-mix(in srgb, var(--primary) 35%, transparent));
    border-radius: var(--radius-sm);
  }

  .status-icon {
    display: inline-flex;
    width: 0.85rem;
    height: 0.85rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }

  .status-icon.done {
    opacity: 0.75;
  }

  .status-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 999px;
    flex-shrink: 0;
    background: var(--muted-foreground);
  }

  .status-dot.error {
    background: var(--error, #ef4444);
  }

  .agent-line-text {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Shimmer host needs inline-block for gradient text; keep ellipsis on outer */
  .agent-line-text.aui-shimmer-host {
    display: inline-block;
    vertical-align: bottom;
  }
</style>
