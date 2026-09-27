<svelte:options runes={true} />

<script lang="ts">
  import {
    AlertCircle,
    Bot,
    Check,
    ChevronDown,
    Eye,
    FilePen,
    FileSearch,
    Globe,
    Loader2,
    Terminal,
    XCircle
  } from 'lucide-svelte';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import type { AgentStep } from '$lib/types/chat';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { formatToolDuration, titleCaseToolName, toolStatusLabel } from '$lib/utils/tool-ui';
  import { copy } from '$lib/copy';

  interface Props {
    step: AgentStep;
  }

  let { step }: Props = $props();

  /** Tool output past this point is elided; the full text lives in the log. */
  const OUTPUT_LIMIT = 6000;

  let expanded = $state(false);
  let userToggled = $state(false);
  let runStartedAt = $state<number | null>(null);
  let elapsedMs = $state<number | undefined>(undefined);
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  const isRunning = $derived(step.status === 'running' || step.status === 'pending');
  const isApproval = $derived(step.status === 'awaiting_approval');
  const isError = $derived(step.status === 'error');
  const hasBody = $derived(!!(step.detail || step.output));
  const adds = $derived(step.diffStats?.reduce((s, d) => s + d.additions, 0) || 0);
  const dels = $derived(step.diffStats?.reduce((s, d) => s + d.deletions, 0) || 0);
  const heading = $derived(titleCaseToolName(step.label || step.type));
  const preview = $derived((step.detail || '').replace(/\s+/g, ' ').trim().slice(0, 160));

  const Icon = $derived.by(() => {
    if (isRunning) return Loader2;
    if (isApproval) return AlertCircle;
    if (isError) return XCircle;
    if (step.status === 'done') return Check;
    if (step.type === 'executing' || /bash|shell|command|terminal/i.test(step.label)) return Terminal;
    if (step.type === 'writing' || /write|create|file/i.test(step.label)) return FilePen;
    if (step.type === 'reading' || /read|fetch/i.test(step.label)) return FileSearch;
    if (step.type === 'searching' || /search|grep|find/i.test(step.label)) return Globe;
    if (step.type === 'preview' || /preview|view/i.test(step.label)) return Eye;
    if (step.type === 'thinking' || step.type === 'planning') return Bot;
    return Terminal;
  });

  const statusLabel = $derived(toolStatusLabel(step.status));

  function toggle() {
    if (!hasBody && !isApproval) return;
    userToggled = true;
    expanded = !expanded;
  }

  $effect(() => {
    if (!userToggled) {
      expanded = isError || isApproval || (isRunning && !!step.output);
    }
  });

  $effect(() => {
    if (isRunning) {
      if (runStartedAt == null) runStartedAt = Date.now();
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = setInterval(() => {
        if (runStartedAt != null) elapsedMs = Date.now() - runStartedAt;
      }, 200);
      elapsedMs = runStartedAt != null ? Date.now() - runStartedAt : 0;
    } else if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    return () => {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
    };
  });

  // The store is reactive now, so this is a read rather than a subscription.
  const pendingMatch = $derived(approvalsStore.items.some((a) => a.id === step.id));
  const showApproval = $derived(isApproval || pendingMatch);
  const durationText = $derived(
    elapsedMs !== undefined && (isRunning || step.status === 'done' || isError)
      ? formatToolDuration(elapsedMs)
      : ''
  );

  function allow() {
    approvalsStore.resolve(step.id, true);
  }

  function deny() {
    approvalsStore.resolve(step.id, false);
  }
</script>

<div class="aui-tool-row" data-awaiting-approval={isApproval} class:has-body={hasBody || showApproval} class:is-resting={step.status === 'done' && !expanded}>
  <button
    type="button"
    class="aui-tool-fallback-trigger w-full max-w-none"
    onclick={toggle}
    aria-expanded={hasBody || showApproval ? expanded : undefined}
    disabled={!hasBody && !showApproval}
  >
    <Icon class="aui-tool-fallback-trigger-icon {isRunning ? 'is-running' : ''}" />
    <span class="min-w-0 flex-1 text-left">
      <span class="block truncate">
        {#if statusLabel}<span class="opacity-70">{statusLabel} · </span>{/if}<b>{heading}</b>
        {#if preview && !expanded}
          <span class="ml-1 font-normal opacity-60">{preview}</span>
        {/if}
      </span>
    </span>
    {#if adds || dels}
      <span class="diff-trail">
        {#if adds}<span class="adds">+{adds}</span>{/if}
        {#if dels}<span class="dels">-{dels}</span>{/if}
      </span>
    {/if}
    {#if durationText}
      <span class="aui-tool-fallback-duration">{durationText}</span>
    {/if}
    {#if hasBody || showApproval}
      <ChevronDown class={`aui-tool-fallback-chevron ${expanded ? '' : 'is-closed'}`} />
    {/if}
  </button>

  {#if expanded && (hasBody || showApproval)}
    <div
      class="aui-tool-fallback-content"
      transition:slide={{ duration: 160, easing: quintOut }}
    >
      {#if isError && (step.output || step.detail)}
        <div>
          <p class="aui-tool-fallback-error-header">{copy.tool.error}:</p>
          <p class="aui-tool-fallback-error-reason">{(step.output || step.detail || '').slice(0, OUTPUT_LIMIT)}</p>
        </div>
      {:else}
        {#if step.detail}
          <pre class="aui-tool-fallback-args-value">{step.detail}</pre>
        {/if}
        {#if step.output}
          <div>
            <p class="aui-tool-fallback-result-header">{copy.tool.result}:</p>
            <pre class="aui-tool-fallback-result-content">{step.output.slice(0, OUTPUT_LIMIT)}{step.output.length > OUTPUT_LIMIT ? `\n${copy.tool.truncated}` : ''}</pre>
          </div>
        {/if}
      {/if}

      {#if showApproval}
        <div class="aui-tool-fallback-approval">
          <button type="button" class="aui-tool-fallback-approval-btn" onclick={deny}>{copy.tool.deny}</button>
          <button type="button" class="aui-tool-fallback-approval-btn primary" onclick={allow}>{copy.tool.allow}</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .aui-tool-row {
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .aui-tool-row :global(.aui-tool-fallback-trigger) { border-radius: var(--radius-md); background: transparent; padding: 0.5rem 0.625rem; font-size: 0.75rem; }
  .aui-tool-row :global(.aui-tool-fallback-trigger:hover) { background: var(--muted); }
  .aui-tool-row :global(.aui-tool-fallback-content) { margin: 0 0.625rem 0.5rem; border-left: 1px solid var(--border); padding: 0.5rem 0.75rem; background: transparent; }
  .aui-tool-row :global(pre) { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 18rem; overflow-y: auto; font-size: 0.6875rem; }

  /* Completed, collapsed work steps back so the answer leads; hover restores
     full contrast. Running / error / expanded rows stay at full weight. */
  .aui-tool-row.is-resting :global(.aui-tool-fallback-trigger) {
    opacity: 0.72;
  }

  .aui-tool-row.is-resting:hover :global(.aui-tool-fallback-trigger) {
    opacity: 1;
  }

  .aui-tool-row :global(.aui-tool-fallback-trigger:disabled) {
    cursor: default;
  }

  .diff-trail {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .adds {
    color: var(--success);
  }

  .dels {
    color: var(--error);
  }
</style>
