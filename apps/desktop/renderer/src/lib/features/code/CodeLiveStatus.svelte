<svelte:options runes={true} />

<!--
  The one line under a live reply that says what is happening right now,
  with how long the run has taken — the TUI's activity strip, assistant-ui's
  thinking indicator. It names what is otherwise invisible: a tool call the
  model is still writing ("Writing changes · 3.2 KB"), a command running, a
  quiet model, an approval waiting on you.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { copy } from '$lib/copy';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import type { CodeRunState } from './code-run';
  import { toolKind } from '$shared/tool-kinds';
  import { liveStatus, QUIET_MS, type LiveStatus } from './work-blocks';

  let { run, awaitingApproval = false }: { run: CodeRunState; awaitingApproval?: boolean } = $props();

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });

  const status = $derived(liveStatus(run, awaitingApproval, now));
  const elapsed = $derived(run.startedAt ? formatToolDuration(now - run.startedAt) : '');

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
    // The running row sits right above: the line only keeps time.
    running: () => copy.status.working,
    thinking: () => $t('code.thinking'),
    writing: () => $t('code.live.writing'),
    waiting: (status) => (status.quietMs >= QUIET_MS ? `${$t('code.live.waiting')} · ${Math.floor(status.quietMs / 1000)}s` : $t('code.live.waiting'))
  };
  const label = $derived((labels[status.kind] as (status: LiveStatus) => string)(status));
</script>

<div class="live" class:is-waiting={status.kind === 'approval'} role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>
  <span class="min-w-0 truncate">
    <span class={status.kind === 'thinking' || status.kind === 'writing' ? 'ui-legacy-shimmer-text' : 'text-foreground'}>{label}</span>
  </span>
  {#if elapsed}<span class="shrink-0 tabular-nums">· {elapsed}</span>{/if}
</div>

<style>
  .live {
    display: flex;
    max-width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 13px;
    color: var(--muted-foreground);
  }
  .dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--brand-accent, var(--primary));
    animation: live-breathe 1.4s ease-in-out infinite;
  }
  .live.is-waiting .dot {
    background: var(--warning);
  }
  @keyframes live-breathe {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot { animation: none; }
  }
</style>
