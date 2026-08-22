<svelte:options runes={true} />

<!--
  Inline download row — the only download UI.

  Progress, speed and ETA live on the same row as the artifact that started
  them, so a download never needs a separate surface to be understood.
  Pause keeps partial bytes (.part) for a true resume; cancel discards them.
-->

<script lang="ts">
  import { LoaderCircle, Pause, Play, X } from 'lucide-svelte';
  import type { DownloadJob } from '$lib/types/bridge';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { formatBytes } from '$lib/utils/format';

  interface Props {
    job: DownloadJob;
    /** Shorthand label when the filename is already visible on the row. */
    compact?: boolean;
  }

  let { job, compact = false }: Props = $props();

  const running = $derived(job.status === 'running' || job.status === 'queued');
  const resumable = $derived(['paused', 'interrupted', 'error'].includes(job.status));
  const speed = $derived(downloadsStore.getJobSpeed(job.id));

  function formatEta(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  }
</script>

<div class="download-row" data-status={job.status} role="status">
  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-2 text-xs">
      {#if running}
        <LoaderCircle class="size-3.5 shrink-0 animate-spin text-[var(--text-muted)]" />
      {/if}
      <span class="truncate font-medium text-[var(--text)]">
        {compact ? '' : job.file}
        {#if compact}{Math.round(job.progress)}%{/if}
      </span>
      <span class="shrink-0 tabular-nums text-[var(--text-muted)]">
        {#if job.total_bytes > 0}
          {formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}
        {:else}
          {formatBytes(job.downloaded_bytes)}
        {/if}
      </span>
      {#if running && speed}
        <span class="shrink-0 tabular-nums text-[var(--text-muted)]">
          {formatBytes(speed.speedBps)}/s{speed.etaSeconds > 0 ? ` · ${formatEta(speed.etaSeconds)} left` : ''}
        </span>
      {/if}
      {#if job.status === 'paused'}
        <span class="shrink-0 text-[var(--warning)]">Paused</span>
      {:else if job.status === 'interrupted'}
        <span class="shrink-0 text-[var(--warning)]">Interrupted — resume to continue</span>
      {:else if job.status === 'error'}
        <span class="truncate text-[var(--danger)]" title={job.error || ''}>{job.error}</span>
      {/if}
    </div>

    <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]">
      <div
        class="h-full rounded-full transition-[width] duration-500 ease-out {job.status === 'error' ? 'bg-[var(--danger)]' : 'bg-[var(--foreground)]'}"
        style={`width: ${job.progress}%`}
      >
      </div>
    </div>

    {#if job.load_when_ready && !['completed'].includes(job.status)}
      <p class="mt-1 text-[10px] text-[var(--text-muted)]">Will load automatically when ready</p>
    {/if}
  </div>

  <div class="flex shrink-0 items-center gap-1">
    {#if running}
      <button
        type="button"
        class="aui-icon-button size-7"
        onclick={() => void downloadsStore.pauseJob(job.id).then(() => downloadsStore.refresh())}
        aria-label="Pause download"
        title="Pause (keeps downloaded bytes)"
      >
        <Pause class="size-3.5" />
      </button>
      <button
        type="button"
        class="aui-icon-button size-7"
        onclick={() => void downloadsStore.cancelJob(job.id)}
        aria-label="Cancel download"
        title="Cancel (discards partial bytes)"
      >
        <X class="size-3.5" />
      </button>
    {:else if resumable}
      <button
        type="button"
        class="aui-icon-button size-7"
        onclick={() => void downloadsStore.resumeJob(job)}
        aria-label="Resume download"
        title="Resume from where it stopped"
      >
        <Play class="size-3.5" />
      </button>
      <button
        type="button"
        class="aui-icon-button size-7"
        onclick={() => void downloadsStore.removeJob(job.id)}
        aria-label="Dismiss"
        title="Dismiss this entry"
      >
        <X class="size-3.5" />
      </button>
    {/if}
  </div>
</div>

<style>
  .download-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    padding: 0.5rem 0.625rem;
  }
</style>
