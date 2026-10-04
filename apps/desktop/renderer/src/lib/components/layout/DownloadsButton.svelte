<svelte:options runes={true} />

<!--
  The titlebar's download manager: every download — chat models, dictation
  and voice models, engines — with progress, speed and time left, pause /
  resume where the transfer can resume, cancel, and a short "Earlier" list.
-->

<script lang="ts">
  import { locale, t } from 'svelte-i18n';
  import { Brain, Cpu, Download, FolderOpen, Loader2, Mic, Pause, Play, RotateCcw, Volume2, X } from 'lucide-svelte';
  import { Menu } from '$lib/components/ui';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { invoke } from '$lib/services/bridge';
  import { formatBytes } from '$lib/utils/format';
  import type { DownloadJob } from '$lib/types/bridge';

  let { class: className = '' }: { class?: string } = $props();
  let open = $state(false);

  const ICONS = { chat: Brain, speech: Mic, voice: Volume2, engine: Cpu } as const;
  const LIVE = new Set(['starting', 'running', 'queued', 'paused', 'interrupted', 'error']);

  const current = $derived(downloadsStore.jobs.filter((job) => LIVE.has(job.status)));
  const earlier = $derived(downloadsStore.jobs.filter((job) => !LIVE.has(job.status)).slice(0, 6));

  $effect(() => {
    if (open) void downloadsStore.refresh();
  });

  const resumable = (job: DownloadJob) => job.kind === 'hf_model';

  function name(job: DownloadJob): string {
    return job.label || job.model_id || job.file;
  }

  function duration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return $t('downloads.secondsLeft', { values: { n: Math.ceil(seconds) } });
    if (seconds < 3600) return $t('downloads.minutesLeft', { values: { n: Math.ceil(seconds / 60) } });
    return $t('downloads.hoursLeft', { values: { n: Math.round(seconds / 360) / 10 } });
  }

  function meta(job: DownloadJob): string {
    const size = job.total_bytes ? `${formatBytes(job.downloaded_bytes)} / ${formatBytes(job.total_bytes)}` : formatBytes(job.downloaded_bytes);
    if (job.status === 'running' || job.status === 'starting') {
      const speed = downloadsStore.getJobSpeed(job.id);
      return [size, speed ? `${formatBytes(speed.speedBps)}/s` : '', speed ? duration(speed.etaSeconds) : ''].filter(Boolean).join(' · ');
    }
    if (job.status === 'error') return job.error || $t('downloads.failed');
    return `${$t(`downloads.status.${job.status}`)} · ${size}`;
  }

  function ago(ts: number): string {
    const minutes = Math.round((Date.now() - ts) / 60000);
    const fmt = new Intl.RelativeTimeFormat($locale || undefined, { numeric: 'auto' });
    if (minutes < 60) return fmt.format(-minutes, 'minute');
    if (minutes < 1440) return fmt.format(-Math.round(minutes / 60), 'hour');
    return fmt.format(-Math.round(minutes / 1440), 'day');
  }
</script>

<Menu bind:open placement="bottom-end" minWidth="22rem" label={$t('downloads.title')}>
  {#snippet trigger(props)}
    <button
      type="button"
      class="ui-icon-button download-btn relative {className}"
      class:is-active={downloadsStore.hasActive}
      aria-label={$t('downloads.title')}
      title={downloadsStore.activeCount ? $t('downloads.active', { values: { n: downloadsStore.activeCount } }) : $t('downloads.title')}
      {...props}
    >
      {#if downloadsStore.hasActive}
        <Loader2 class="size-4 animate-spin" />
        <span class="badge">{downloadsStore.activeCount}</span>
      {:else}
        <Download class="size-4" />
      {/if}
    </button>
  {/snippet}

  <div class="panel">
    <div class="head">
      <span class="title">{$t('downloads.title')}</span>
      <button type="button" class="link" onclick={() => void invoke('open_data_folder')}><FolderOpen class="size-3.5" />{$t('downloads.openFolder')}</button>
    </div>

    {#if !current.length && !earlier.length}
      <p class="empty">{$t('downloads.empty')}</p>
    {/if}

    {#each current as job (job.id)}
      {@const Icon = ICONS[job.category ?? 'chat']}
      <div class="job">
        <span class="icon"><Icon class="size-4" /></span>
        <div class="body">
          <p class="name" title={name(job)}>{name(job)}</p>
          <p class="meta" class:error={job.status === 'error'}>{meta(job)}</p>
          <div class="bar" aria-hidden="true"><span class:paused={job.status !== 'running'} style:width={`${Math.max(2, (job.progress || 0) * 100)}%`}></span></div>
        </div>
        <div class="actions">
          {#if resumable(job) && (job.status === 'running' || job.status === 'queued')}
            <button type="button" class="act" onclick={() => void downloadsStore.pauseJob(job.id)} aria-label={$t('downloads.pause')} title={$t('downloads.pause')}><Pause class="size-3.5" /></button>
          {:else if resumable(job) && (job.status === 'paused' || job.status === 'interrupted')}
            <button type="button" class="act" onclick={() => void downloadsStore.resumeJob(job)} aria-label={$t('downloads.resume')} title={$t('downloads.resume')}><Play class="size-3.5" /></button>
          {:else if resumable(job) && job.status === 'error'}
            <button type="button" class="act" onclick={() => void downloadsStore.retryJob(job.id)} aria-label={$t('downloads.retry')} title={$t('downloads.retry')}><RotateCcw class="size-3.5" /></button>
          {/if}
          {#if job.status === 'running' || job.status === 'queued' || job.status === 'starting' || job.status === 'paused'}
            <button type="button" class="act" onclick={() => void downloadsStore.cancelJob(job.id)} aria-label={$t('downloads.cancel')} title={$t('downloads.cancel')}><X class="size-3.5" /></button>
          {:else}
            <button type="button" class="act" onclick={() => void downloadsStore.removeJob(job.id)} aria-label={$t('downloads.remove')} title={$t('downloads.remove')}><X class="size-3.5" /></button>
          {/if}
        </div>
      </div>
    {/each}

    {#if earlier.length}
      <div class="section">
        <span>{$t('downloads.earlier')}</span>
        <button type="button" class="link" onclick={() => void downloadsStore.clearFinished()}>{$t('downloads.clear')}</button>
      </div>
      {#each earlier as job (job.id)}
        {@const Icon = ICONS[job.category ?? 'chat']}
        <div class="job done">
          <span class="icon"><Icon class="size-4" /></span>
          <div class="body">
            <p class="name" title={name(job)}>{name(job)}</p>
            <p class="meta">{[$t(`downloads.status.${job.status}`), job.total_bytes ? formatBytes(job.total_bytes) : '', ago(job.timestamp)].filter(Boolean).join(' · ')}</p>
          </div>
          <button type="button" class="act ghost" onclick={() => void downloadsStore.removeJob(job.id)} aria-label={$t('downloads.remove')} title={$t('downloads.remove')}><X class="size-3.5" /></button>
        </div>
      {/each}
    {/if}
  </div>
</Menu>

<style>
  .badge {
    position: absolute;
    right: -2px;
    top: -2px;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--sidebar-primary);
    color: var(--sidebar-primary-foreground);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 16px;
    text-align: center;
  }

  .panel {
    display: flex;
    max-height: min(28rem, 70vh);
    flex-direction: column;
    gap: 0.15rem;
    overflow-y: auto;
    padding: 0.35rem 0.3rem 0.4rem;
  }

  .head,
  .section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.2rem 0.4rem 0.35rem;
  }

  .title {
    font-size: 0.85rem;
    font-weight: 600;
  }

  .section {
    margin-top: 0.3rem;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border-subtle);
    font-size: 0.72rem;
    color: var(--muted-foreground);
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: 0;
    background: none;
    padding: 0;
    font-size: 0.75rem;
    color: var(--muted-foreground);
  }

  .link:hover {
    color: var(--foreground);
  }

  .empty {
    margin: 0;
    padding: 1.25rem 0.4rem;
    text-align: center;
    font-size: 0.8rem;
    color: var(--muted-foreground);
  }

  .job {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.4rem;
    border-radius: 0.6rem;
  }

  .job:hover {
    background: var(--muted);
  }

  .icon {
    display: flex;
    width: 1.9rem;
    height: 1.9rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    background: var(--muted);
    color: var(--muted-foreground);
  }

  .job:hover .icon {
    background: var(--background);
  }

  .body {
    min-width: 0;
    flex: 1;
  }

  .name {
    margin: 0;
    overflow: hidden;
    font-size: 0.8rem;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .meta {
    margin: 0.05rem 0 0;
    overflow: hidden;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .meta.error {
    color: var(--error);
  }

  .bar {
    height: 3px;
    margin-top: 0.35rem;
    overflow: hidden;
    border-radius: 999px;
    background: var(--muted);
  }

  .job:hover .bar {
    background: var(--background);
  }

  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--foreground);
    transition: width 300ms var(--motion-ease);
  }

  .bar span.paused {
    opacity: 0.35;
  }

  .actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.1rem;
  }

  .act {
    display: inline-flex;
    width: 1.6rem;
    height: 1.6rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted-foreground);
  }

  .act:hover {
    background: var(--background);
    color: var(--foreground);
  }

  .act.ghost {
    opacity: 0;
  }

  .job:hover .act.ghost,
  .act.ghost:focus-visible {
    opacity: 1;
  }
</style>
