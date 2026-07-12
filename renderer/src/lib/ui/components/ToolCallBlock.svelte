<svelte:options runes={true} />

<script lang="ts">
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import {
    AlertCircle,
    Check,
    ChevronDown,
    Loader2,
    Terminal,
    XCircle
  } from 'lucide-svelte';
  import {
    formatToolDuration,
    isCodeToolName,
    titleCaseToolName,
    toolStatusLabel,
    type ToolUiStatus
  } from '$lib/utils/tool-ui';

  interface Props {
    name: string;
    status?: ToolUiStatus;
    detail?: string;
    output?: string;
    error?: string;
    cancelled?: boolean;
    onApprove?: () => void;
    onDeny?: () => void;
  }

  let {
    name,
    status = 'running',
    detail,
    output,
    error,
    cancelled = false,
    onApprove,
    onDeny
  }: Props = $props();

  let open = $state(false);
  let userToggled = $state(false);
  let runStartedAt = $state<number | null>(null);
  let elapsedMs = $state<number | undefined>(undefined);
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  const isCodeTool = $derived(isCodeToolName(name));
  const displayName = $derived(titleCaseToolName(name));
  const isRunning = $derived(status === 'running' || status === 'pending');
  const isApproval = $derived(status === 'awaiting_approval');
  const isError = $derived(status === 'error');
  const isCancelled = $derived(cancelled || (isError && /cancel/i.test(error || output || '')));

  const label = $derived(
    isCancelled
      ? 'Cancelled tool'
      : isApproval
        ? 'Needs approval'
        : toolStatusLabel(status)
  );

  function toggle() {
    userToggled = true;
    open = !open;
  }

  $effect(() => {
    if (!userToggled) {
      open = isError || isApproval || (isRunning && isCodeTool);
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
    } else {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
      if (runStartedAt != null && elapsedMs === undefined) {
        elapsedMs = Date.now() - runStartedAt;
      }
    }
    return () => {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
    };
  });

  const durationText = $derived(
    elapsedMs !== undefined && (isRunning || status === 'done' || isError)
      ? formatToolDuration(elapsedMs)
      : ''
  );
</script>

<div class="aui-tool-fallback-root" data-slot="tool-fallback-root">
  <button type="button" class="aui-tool-fallback-trigger" onclick={toggle} data-slot="tool-fallback-trigger">
    {#if isRunning}
      <Loader2 class="aui-tool-fallback-trigger-icon is-running" />
    {:else if isApproval}
      <AlertCircle class="aui-tool-fallback-trigger-icon" />
    {:else if isError || isCancelled}
      <XCircle class="aui-tool-fallback-trigger-icon" />
    {:else}
      <Check class="aui-tool-fallback-trigger-icon" />
    {/if}

    <span
      class="aui-shimmer-host"
      class:aui-tool-fallback-label-cancelled={isCancelled}
    >
      <span>
        {label}: <b>{displayName}</b>
      </span>
      {#if isRunning}
        <span class="aui-shimmer" aria-hidden="true">
          {label}: <b>{displayName}</b>
        </span>
      {/if}
    </span>

    {#if durationText}
      <span class="aui-tool-fallback-duration">{durationText}</span>
    {/if}

    <ChevronDown class={`aui-tool-fallback-chevron ${open ? '' : 'is-closed'}`} />
  </button>

  {#if open}
    <div
      class="aui-tool-fallback-content"
      transition:slide={{ duration: 200, easing: quintOut }}
      data-slot="tool-fallback-content"
    >
      {#if isError && (error || output)}
        <div data-slot="tool-fallback-error">
          <p class="aui-tool-fallback-error-header">
            {isCancelled ? 'Cancelled reason:' : 'Error:'}
          </p>
          <p class="aui-tool-fallback-error-reason">{error || output}</p>
        </div>
      {/if}

      {#if detail && !isCodeTool}
        <div data-slot="tool-fallback-args">
          <pre class="aui-tool-fallback-args-value">{detail}</pre>
        </div>
      {/if}

      {#if isApproval && (onApprove || onDeny)}
        <div class="aui-tool-fallback-approval" data-slot="tool-fallback-approval">
          {#if onDeny}
            <button type="button" class="aui-tool-fallback-approval-btn" onclick={onDeny}>Deny</button>
          {/if}
          {#if onApprove}
            <button type="button" class="aui-tool-fallback-approval-btn primary" onclick={onApprove}>Allow</button>
          {/if}
        </div>
      {/if}

      {#if output && !isError}
        <div data-slot="tool-fallback-result">
          <p class="aui-tool-fallback-result-header">
            {#if isCodeTool}
              <span class="inline-flex items-center gap-1"><Terminal class="size-3" /> Output</span>
            {:else}
              Result:
            {/if}
          </p>
          <pre class={isCodeTool ? 'aui-tool-fallback-terminal' : 'aui-tool-fallback-result-content'}>{output}</pre>
        </div>
      {/if}

      {#if detail && isCodeTool && !output}
        <div data-slot="tool-fallback-args">
          <pre class="aui-tool-fallback-args-value">{detail}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>
