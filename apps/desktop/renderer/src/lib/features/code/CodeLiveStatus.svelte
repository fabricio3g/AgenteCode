<svelte:options runes={true} />

<!--
  The one line under a live reply that says what is happening right now,
  with how long the run has taken, matching the TUI's activity strip. It names what is otherwise invisible: a tool call the
  model is still writing ("Writing changes · 3.2 KB"), a command running, a
  quiet model, an approval waiting on you.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { copy } from '$lib/copy';
  import { formatToolDuration, titleCaseToolName } from '$lib/utils/tool-ui';
  import { codeRunElapsed, type CodeRunState } from './code-run';
  import { toolKind } from '$shared/tool-kinds';
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import { appearanceStore } from '$lib/stores/appearance.svelte';
  import { liveStatus, QUIET_MS, type LiveStatus } from './work-blocks';
  import { runMeterMode, type MeterRun } from './tile-meter';

  type LiveRun = MeterRun & Pick<CodeRunState, 'startedAt' | 'endedAt' | 'elapsedMs' | 'activeStartedAt'> & Partial<Pick<CodeRunState, 'children'>>;
  let { run, awaitingApproval = false }: { run: LiveRun; awaitingApproval?: boolean } = $props();

  const agentStyle = $derived(appearanceStore.prefs.agentStyle);

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });

  const status = $derived(liveStatus(run, awaitingApproval, now));
  const elapsed = $derived(run.startedAt !== undefined ? formatToolDuration(codeRunElapsed(run, now)) : '');

  /*
   * The meter answers "is it still working?" before the label is read: rain at
   * full tilt while the engine is producing, a drizzle once it has gone quiet
   * for a beat, an amber square while it waits on you, and the still frame the
   * moment you ask it to stop.
   */
  const mode = $derived(runMeterMode(run, awaitingApproval, now));

  function verb(toolName: string): string {
    const verbs = copy.codeRun as Record<string, string>;
    return (Object.hasOwn(verbs, toolName) ? verbs[toolName] : toolName.replace(/[_-]+/g, ' ')).toLowerCase();
  }

  function size(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  function preparingLabel(toolName: string, bytes: number): string {
    const kind = toolKind(toolName);
    const what = kind === 'edit' ? $t('code.live.preparingEdit') : kind === 'command' ? $t('code.live.preparingCommand') : $t('code.live.preparing', { values: { tool: verb(toolName) } });
    return bytes ? `${what} · ${size(bytes)}` : what;
  }

  type Labels = { [K in LiveStatus['kind']]: (status: Extract<LiveStatus, { kind: K }>) => string };
  const labels: Labels = {
    approval: () => $t('code.live.approval'),
    retry: (status) => $t('code.retrying', { values: { n: status.attempt } }),
    preparing: (status) => preparingLabel(status.toolName, status.bytes),
    running: (status) => {
      // A wait on a subagent names the agent, not its id.
      const child = status.step.toolName === 'task_output' ? run.children?.find((candidate) => candidate.id === status.step.subagentId) : undefined;
      if (child) return $t('code.live.waitingFor', { values: { agent: [titleCaseToolName(child.kind || 'subagent'), child.description].filter(Boolean).join(' · ') } });
      // The running row above already names the call ("Read src/index.ts"):
      // repeating it here said everything twice. This line keeps the run's pulse.
      return copy.status.working;
    },
    thinking: () => $t('code.thinking'),
    writing: () => $t('code.live.writing'),
    starting: () => $t('code.live.starting'),
    requesting: () => $t('code.live.requesting'),
    compacting: () => copy.codeRun.compacting
  };
  const quietMs = $derived(run.lastEventAt === undefined ? 0 : Math.max(0, now - run.lastEventAt));
  const label = $derived((labels[status.kind] as (status: LiveStatus) => string)(status));
</script>

<!-- An approval is already on screen with its diff and its Allow / Deny: a
     third "waiting for your approval" line here only repeated it. -->
{#if status.kind !== 'approval'}
<div class="live" data-live-style={agentStyle} role="status" aria-live="polite">
  <TileMeter {mode} />
  <span class="min-w-0 truncate">
    <span class="text-foreground" class:ui-shimmer-text={mode !== 'stopped' && mode !== 'attention'}>{label}</span>
  </span>
  {#if quietMs >= QUIET_MS}<span class="shrink-0">· {$t('code.live.noUpdate', { values: { seconds: Math.floor(quietMs / 1000) } })}</span>{/if}
  {#if elapsed}<span class="shrink-0 tabular-nums">· {elapsed}</span>{/if}
</div>
{/if}

<style>
  .live {
    display: flex;
    max-width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0.625rem;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--muted-foreground);
  }
</style>
