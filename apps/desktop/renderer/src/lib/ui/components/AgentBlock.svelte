<svelte:options runes={true} />

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import type { AgentActivity, AgentOutcome, AgentStopReason, ChatMessage } from '$lib/types/chat';
  import { Check, ChevronDown, CircleAlert, CircleStop } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import ToolCallRow from '$lib/components/agent/ToolCallRow.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { ActiveDuration } from '$lib/utils/active-duration';
  import { formatDuration, plural } from '$lib/utils/format';
  import { activityLabel as resolveActivityLabel, searchModeChip } from '$lib/utils/tool-ui';

  interface Props {
    steps?: ChatMessage['agentSteps'];
    reasoning?: string;
    status?: ChatMessage['status'];
    totalElapsedSeconds?: number;
    outcome?: AgentOutcome;
    stopReason?: AgentStopReason;
    currentActivity?: AgentActivity;
    activityLabel?: string;
    messageId?: string;
    /** When deep/max search is active, show a quiet mode chip */
    searchMode?: 'chat' | 'search' | 'deep' | 'max' | null;
    /**
     * The run is blocked on an approval. Passed in because the supervised-bash
     * path never marks a *step* `awaiting_approval`, so sniffing the steps
     * (below) misses it entirely.
     */
    awaitingApproval?: boolean;
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
    messageId = '',
    searchMode = null,
    awaitingApproval = false
  }: Props = $props();

  const modeChip = $derived(searchModeChip(searchMode));

  const errCount = $derived(steps.filter((s) => s.status === 'error').length);
  const visibleSteps = $derived(steps.filter((s) => s.type !== 'thinking' && s.type !== 'planning' || s.status === 'error'));
  const doneCount = $derived(visibleSteps.filter((s) => s.status === 'done').length);
  const hasApproval = $derived(awaitingApproval || steps.some((s) => s.status === 'awaiting_approval'));
  const stoppedByUser = $derived(steps.some((s) => /stopped by user/i.test(s.detail || s.label || '')));
  const isStreaming = $derived(status === 'streaming');
  const hasRelevance = $derived(!!(steps.length || reasoning) || isStreaming);
  let expanded = $state(false);
  const failed = $derived(outcome === 'failed' || status === 'error' || errCount > 0);
  const stopped = $derived(stoppedByUser || outcome === 'partial' || outcome === 'stopped' || stopReason !== 'none');

  /** Debounced short label so progress ticks don't thrash the line. */
  let stableVerb = $state(resolveActivityLabel(null));
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const clock = new ActiveDuration();
  let liveElapsed = $state(0);

  /**
   * Prefer the reported activity; fall back to sniffing the label only for
   * older messages persisted before `currentActivity` was recorded.
   */
  function shortVerb(activity?: AgentActivity | null, label?: string | null): string {
    if (activity) return resolveActivityLabel(activity);

    const raw = String(label || '').toLowerCase();
    if (raw.includes('search')) return resolveActivityLabel('searching');
    if (raw.includes('read') || raw.includes('fetch') || raw.includes('source')) {
      return resolveActivityLabel('reading');
    }
    if (/file|document|artifact|answer|response/.test(raw)) return resolveActivityLabel('writing');
    return resolveActivityLabel(null);
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
    if (isStreaming && stableVerb === copy.status.working) {
      const next = shortVerb(currentActivity, activityLabel);
      if (next !== copy.status.working) stableVerb = next;
    }
  });

  $effect(() => {
    if (!isStreaming) return;
    clock.resume();
    liveElapsed = clock.elapsed() / 1000;
    const timer = setInterval(() => (liveElapsed = clock.elapsed() / 1000), 250);
    return () => { clearInterval(timer); clock.pause(); };
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
      if (hasApproval) return copy.tool.needsApproval;
      const t = elapsedLive();
      const core = t ? `${stableVerb} · ${t}` : stableVerb;
      return modeChip ? `${modeChip} · ${core}` : core;
    }

    if (stoppedByUser) return copy.tool.stopped;
    if (outcome === 'failed') {
      const s = Number(totalElapsedSeconds || 0);
      return s > 0 ? `${copy.tool.failed} · ${s.toFixed(1)}s` : copy.tool.failed;
    }
    if (outcome === 'partial' || outcome === 'stopped' || stopReason !== 'none') {
      const s = Number(totalElapsedSeconds || 0);
      const time = s > 0 ? ` · ${s.toFixed(1)}s` : '';
      return `${copy.tool.stopped}${time}`;
    }

    if (steps.length) {
      // The message footer owns the source count — do not repeat it here.
      const parts: string[] = [];
      if (errCount) parts.push(`${errCount} ${plural(errCount, 'error')}`);
      else if (doneCount) parts.push(`${doneCount} ${plural(doneCount, 'action')}`);
      else parts.push(reasoning ? 'Thought' : copy.tool.done);
      const elapsed = formatDuration(totalElapsedSeconds);
      if (elapsed) parts.push(elapsed);
      return parts.length ? parts.join(' · ') : copy.tool.done;
    }

    const elapsed = formatDuration(totalElapsedSeconds);
    if (elapsed) return elapsed;
    if (reasoning) return copy.status.reasoning;
    return copy.tool.done;
  });
</script>

{#if hasRelevance}
  <div class="agent-status">
    <UiButton variant="plain" type="button" class={uiClass("agent-line", "ui-local-336916d4")} onclick={() => expanded = !expanded} aria-expanded={expanded} aria-label={expanded ? $t('thread.hideActivity') : $t('thread.showActivity')}>
      {#if isStreaming}
        <TileMeter mode={awaitingApproval ? 'attention' : 'busy'} />
        <span class="agent-line-text">
          <span>{line}</span>
        </span>
      {:else}
        {#if failed}
          <CircleAlert class="size-3.5 text-destructive" />
        {:else if stopped}
          <CircleStop class="size-3.5" />
        {:else}
          <span class="status-icon done" aria-hidden="true">
            <Check class="size-3.5" />
          </span>
        {/if}
        <span class="agent-line-text">{line}</span>
      {/if}
      <ChevronDown class={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </UiButton>
    {#if expanded}
      <div class="activity-steps">
        {#if reasoning}
          <div class="thinking-text">{reasoning}</div>
        {/if}
        {#each visibleSteps as step (step.id)}
          <ToolCallRow {step} />
        {/each}
        {#if messageId}
          <UiButton variant="plain" type="button" class={uiClass("activity-link", "ui-local-336916d4")} onclick={openActivity}>{$t('thread.viewFullActivity')}</UiButton>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .agent-status {
    margin-bottom: 0.75rem;
    width: 100%;
    overflow: hidden;
  }

  /* The line is as wide as its text, so the chevron sits right after it. */
  :global(.agent-line.ui-local-336916d4) {
    display: flex;
    width: fit-content;
    max-width: 100%;
    align-items: center;
    gap: 0.4rem;
    padding: 0.375rem 0;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    text-align: left;
    transition: color var(--motion-fast) var(--motion-ease);
  }

  :global(.agent-line:hover.ui-local-336916d4) {
    color: var(--foreground);
  }

  :global(.agent-line:focus-visible.ui-local-336916d4) {
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

  .agent-line-text {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .activity-steps { border-left: 1px solid var(--border); padding: 0.375rem 0.75rem; margin-top: 0.25rem; }
  .thinking-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8125rem; line-height: 1.6; color: var(--muted-foreground); padding: 0.25rem 0 0.75rem; }
  .activity-steps { max-height: 24rem; overflow-y: auto; }
  :global(.activity-link.ui-local-336916d4) { margin: 0.375rem; padding: 0.25rem; border: 0; background: transparent; color: var(--muted-foreground); font-size: 0.75rem; }
  :global(.activity-link:hover.ui-local-336916d4) { color: var(--foreground); }
</style>
