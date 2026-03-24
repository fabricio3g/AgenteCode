<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { Ban, CheckCircle2, Download, Loader2, Pause, RefreshCw, RotateCcw, Trash2, X, XCircle } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import { cancelDownloadJob, pauseDownloadJob } from '$lib/services/downloads';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  function formatSpeed(bps: number): string {
    if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
    return `${(bps / 1024).toFixed(0)} KB/s`;
  }

  function formatEta(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '';
    const s = Math.round(seconds);
    if (s < 60) return `~${s}s`;
    if (s < 3600) return `~${Math.floor(s / 60)}m ${s % 60}s`;
    return `~${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  function formatSize(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  onMount(() => {
    downloadsStore.startPolling();
    void downloadsStore.refresh();
  });

  async function cancel(jobId: string) {
    await cancelDownloadJob(jobId);
    await downloadsStore.refresh();
  }

  async function pause(jobId: string) {
    await pauseDownloadJob(jobId);
    await downloadsStore.refresh();
  }

  async function retry(jobId: string) {
    try {
      await downloadsStore.retryJob(jobId);
      toastStore.success('Download restarted');
    } catch (e) {
      toastStore.error('Failed to retry download');
    }
  }

  async function remove(jobId: string) {
    await downloadsStore.removeJob(jobId);
  }

  function statusColor(status: string) {
    if (status === 'completed' || status === 'done') return 'text-emerald-500';
    if (status === 'error' || status === 'cancelled') return 'text-red-500';
    if (status === 'paused') return 'text-amber-500';
    return 'text-hornero-500';
  }

  function progressBarColor(status: string) {
    if (status === 'completed' || status === 'done') return 'bg-emerald-500';
    if (status === 'error' || status === 'cancelled') return 'bg-red-500';
    if (status === 'paused') return 'bg-amber-400';
    return 'bg-hornero-500';
  }

  function statusLabel(status: string) {
    if (status === 'done') return 'Completed';
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  const activeCount = $derived(downloadsStore.activeCount);
  const hasFinished = $derived(downloadsStore.jobs.some((j) => !['starting', 'running'].includes(j.status)));
</script>

<div class="modal-backdrop fixed inset-0 z-[61] flex items-center justify-center bg-black/40 px-4" transition:fade={{ duration: 150}}>
 <div class="modal-surface flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200}}>
 <!-- Header -->
 <div class="flex items-center justify-between border-b border-[var(--border-light)] px-5 py-4">
 <h3 class="flex items-center gap-2 text-base font-semibold text-[var(--text)]">
 <Download class="h-4 w-4" />
 {#if activeCount > 0}
 Downloads ({activeCount} active)
 {:else}
 Downloads
 {/if}
 {#if activeCount > 0}
 <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1.5 text-[11px] font-semibold text-white">{activeCount}</span>
 {/if}
 </h3>
 <button
 class="rounded-lg p-2 text-[var(--text-muted)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
 onclick={() => (appStore.downloadsOpen = false)}
 aria-label="Close downloads"
 >
 <X class="h-4 w-4" />
 </button>
 </div>

 <!-- Toolbar -->
 <div class="flex items-center justify-between border-b border-[var(--border-light)] px-5 py-3 text-xs text-[var(--text-tertiary)]">
 <span>{downloadsStore.jobs.length} job{downloadsStore.jobs.length === 1 ? '' : 's'}</span>
 <div class="flex items-center gap-2">
 <button
 class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]"
 onclick={() => downloadsStore.refresh()}
 >
 <RefreshCw class="h-3.5 w-3.5" />
 Refresh
 </button>
 {#if hasFinished}
 <button
 class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]"
 onclick={() => downloadsStore.clearFinished()}
 >
 <Trash2 class="h-3.5 w-3.5" />
 Clear finished
 </button>
 {/if}
 </div>
 </div>

 <!-- Job list -->
 <div class="flex-1 space-y-3 overflow-y-auto p-4">
 {#if !downloadsStore.jobs.length}
 <div class="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-black/10 px-4 py-14">
 <Download class="h-8 w-8 text-[var(--text-muted)]" />
 <p class="text-sm text-[var(--text-tertiary)]">No active downloads</p>
 </div>
 {:else}
 {#each downloadsStore.jobs as job (job.id)}
 <div class="rounded-2xl border border-[var(--border)] p-4">
 <div class="flex items-start justify-between gap-4">
 <!-- Status icon + info -->
 <div class="flex min-w-0 items-start gap-3">
 <div class={`mt-0.5 shrink-0 ${statusColor(job.status)}`}>
 {#if job.status === 'running'}
 <Loader2 class="h-4 w-4 animate-spin" />
 {:else if job.status === 'completed' || job.status === 'done'}
 <CheckCircle2 class="h-4 w-4" />
 {:else if job.status === 'error'}
 <XCircle class="h-4 w-4" />
 {:else if job.status === 'paused'}
 <Pause class="h-4 w-4" />
 {:else if job.status === 'cancelled'}
 <Ban class="h-4 w-4" />
 {:else}
 <Download class="h-4 w-4" />
 {/if}
 </div>
 <div class="min-w-0">
 <div class="truncate text-sm font-semibold text-[var(--text)]">{job.label}</div>
 <div class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--text-tertiary)]">
 <span class={statusColor(job.status)}>{statusLabel(job.status)}</span>
 <span>·</span>
 <span class="tabular-nums">{job.progress.toFixed(1)}%</span>
 {#if job.total_bytes > 0}
 <span>·</span>
 <span class="tabular-nums">{formatSize(job.downloaded_bytes)} / {formatSize(job.total_bytes)}</span>
 {/if}
 {#if job.status === 'running'}
 {@const speed = downloadsStore.getJobSpeed(job.id)}
 {#if speed}
 <span>·</span>
 <span class="tabular-nums">{formatSpeed(speed.speedBps)}</span>
 {#if speed.etaSeconds > 0}
 <span>·</span>
 <span class="tabular-nums">{formatEta(speed.etaSeconds)} remaining</span>
 {/if}
 {/if}
 {/if}
 </div>
 </div>
 </div>

 <!-- Action buttons -->
 <div class="flex shrink-0 items-center gap-1">
 {#if job.status === 'running'}
 <button
 class="rounded-lg p-2 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
 onclick={() => pause(job.id)}
 aria-label="Pause download"
 title="Pause"
 >
 <Pause class="h-4 w-4" />
 </button>
 {/if}
 {#if job.status === 'error' || job.status === 'cancelled'}
 <button
 class="rounded-lg p-2 text-[var(--text-tertiary)] transition hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400"
 onclick={() => retry(job.id)}
 aria-label="Retry download"
 title="Retry"
 >
 <RotateCcw class="h-4 w-4" />
 </button>
 {/if}
 {#if job.status === 'running' || job.status === 'starting'}
 <button
 class="rounded-lg p-2 text-[var(--text-tertiary)] transition hover:bg-red-500/10 hover:text-red-500"
 onclick={() => cancel(job.id)}
 aria-label="Cancel download"
 title="Cancel"
 >
 <Ban class="h-4 w-4" />
 </button>
 {/if}
 {#if !['running', 'starting'].includes(job.status)}
 <button
 class="rounded-lg p-2 text-[var(--text-tertiary)] transition hover:bg-red-500/10 hover:text-red-500"
 onclick={() => remove(job.id)}
 aria-label="Remove from list"
 title="Remove"
 >
 <Trash2 class="h-3.5 w-3.5" />
 </button>
 {/if}
 </div>
 </div>

 <!-- Progress bar -->
 <div class="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-highlight)]">
 <div
 class={`h-full rounded-full transition-all duration-300 ${progressBarColor(job.status)} ${job.status === 'running' ? 'animate-pulse' : ''}`}
 style={`width:${Math.max(0, Math.min(100, job.progress))}%`}
 ></div>
 </div>

 {#if job.error}
 <div class="mt-2 flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2">
 <XCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
 <div class="min-w-0 flex-1">
 <p class="text-xs font-medium text-red-600 dark:text-red-400">Download failed</p>
 <p class="mt-0.5 text-xs text-red-500/80 dark:text-red-400/70 break-all">{job.error}</p>
 </div>
 </div>
 {/if}
 </div>
 {/each}
 {/if}
 </div>
 </div>
</div>
