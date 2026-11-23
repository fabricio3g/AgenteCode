import type { DownloadJob } from '$lib/types/bridge';
import { cancelDownloadJob, clearFinishedDownloads, getDownloadJobs, pauseDownloadJob, removeDownloadJob, retryDownloadJob, startDownloadHf } from '$lib/services/downloads';
import { getModelsDirPath } from '$lib/services/models';
import { isElectron, listen } from '$lib/services/bridge';

const ACTIVE_STATUSES = new Set(['starting', 'running']);
const POLL_FALLBACK_MS = 10_000;
const MIN_SPEED_SAMPLE_MS = 250;
const EMA_ALPHA = 0.3;

interface SpeedSample {
  bytesAtLastSample: number;
  timeAtLastSample: number;
  speedBps: number;
}

interface JobSpeed {
  speedBps: number;
  etaSeconds: number;
}

class DownloadsStore {
  jobs = $state<DownloadJob[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  private _pollerHandle: ReturnType<typeof setInterval> | null = null;
  private _unlistenProgress: (() => void) | null = null;
  private _listeningPromise: Promise<void> | null = null;
  private _speedSamples = new Map<string, SpeedSample>();

  get hasActive() {
    return this.jobs.some((j) => ACTIVE_STATUSES.has(j.status));
  }

  get activeCount() {
    return this.jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  }

  /** Find the job (if any) currently downloading a given repo+filename. */
  jobFor(repoId: string, filename: string): DownloadJob | undefined {
    return this.jobs.find(
      (j) => j.repo_id === repoId && j.file === filename
    );
  }

  getJobSpeed(jobId: string): JobSpeed | null {
    const sample = this._speedSamples.get(jobId);
    if (!sample || sample.speedBps <= 0) return null;
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job || job.total_bytes <= 0) return null;
    const remaining = job.total_bytes - job.downloaded_bytes;
    const etaSeconds = remaining > 0 ? remaining / sample.speedBps : 0;
    return { speedBps: sample.speedBps, etaSeconds };
  }

  async refresh() {
    if (!isElectron()) {
      this.jobs = [];
      return;
    }
    this._ensurePushListener();

    this.loading = true;
    this.error = null;
    try {
      const jobs = await getDownloadJobs();
      this.jobs = Array.isArray(jobs) ? jobs : [];
    } catch (error) {
      this.jobs = [];
      this.error = String((error as Error)?.message || error || 'Failed to load downloads');
    } finally {
      this.loading = false;
    }

    this._syncPoller();
  }

  private _ensurePushListener() {
    if (!isElectron() || this._unlistenProgress || this._listeningPromise) return;
    this._listeningPromise = listen<DownloadJob>('download-progress', (job) => {
      if (!job || !job.id) return;
      const idx = this.jobs.findIndex((existing) => existing.id === job.id);
      if (idx >= 0) {
        const next = this.jobs.slice();
        next[idx] = job;
        this.jobs = next;
      } else {
        this.jobs = [job, ...this.jobs];
      }
      this._updateSpeedSample(job);
      this._syncPoller();
    })
      .then((unlisten) => {
        this._unlistenProgress = unlisten;
      })
      .catch(() => {
        this._listeningPromise = null;
      });
  }

  /** Subscribe to push progress events and keep only a low-frequency fallback timer while active. */
  startPolling() {
    this._ensurePushListener();
    if (this._pollerHandle !== null) return;
    this._pollerHandle = setInterval(() => void this._pollTick(), POLL_FALLBACK_MS);
  }

  stopPolling() {
    if (this._pollerHandle !== null) {
      clearInterval(this._pollerHandle);
      this._pollerHandle = null;
    }
  }

  private async _pollTick() {
    if (!isElectron()) return;
    try {
      const jobs = await getDownloadJobs();
      this.jobs = Array.isArray(jobs) ? jobs : [];
    } catch {
      // ignore transient poll errors
      return;
    }
    this._updateSpeedSamples();
    this._syncPoller();
  }

  private _updateSpeedSample(job: DownloadJob) {
    if (job.status !== 'running') {
      this._speedSamples.delete(job.id);
      return;
    }
    const now = Date.now();
    const prev = this._speedSamples.get(job.id);
    if (!prev) {
      this._speedSamples.set(job.id, {
        bytesAtLastSample: job.downloaded_bytes,
        timeAtLastSample: now,
        speedBps: 0
      });
      return;
    }
    const elapsedMs = now - prev.timeAtLastSample;
    if (elapsedMs < MIN_SPEED_SAMPLE_MS) return;
    const dt = elapsedMs / 1000;
    const instantSpeed = (job.downloaded_bytes - prev.bytesAtLastSample) / dt;
    const smoothed = prev.speedBps > 0
      ? EMA_ALPHA * instantSpeed + (1 - EMA_ALPHA) * prev.speedBps
      : instantSpeed;
    this._speedSamples.set(job.id, {
      bytesAtLastSample: job.downloaded_bytes,
      timeAtLastSample: now,
      speedBps: Math.max(0, smoothed)
    });
  }

  private _updateSpeedSamples() {
    const currentJobIds = new Set(this.jobs.map((j) => j.id));

    // Clean up samples for jobs no longer present
    for (const id of this._speedSamples.keys()) {
      if (!currentJobIds.has(id)) this._speedSamples.delete(id);
    }

    for (const job of this.jobs) {
      this._updateSpeedSample(job);
    }
  }

  private _syncPoller() {
    if (this.hasActive) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  async clearFinished() {
    if (!isElectron()) return;
    await clearFinishedDownloads();
    await this.refresh();
  }

  async removeJob(jobId: string) {
    if (!isElectron()) return;
    await removeDownloadJob(jobId);
    this._speedSamples.delete(jobId);
    await this.refresh();
  }

  /** Pause keeps the .part file — a later retryJob resumes from it. */
  async pauseJob(jobId: string) {
    if (!isElectron()) return;
    await pauseDownloadJob(jobId);
    this._speedSamples.delete(jobId);
    await this.refresh();
  }

  /** Cancel discards partial bytes and marks the job cancelled. */
  async cancelJob(jobId: string) {
    if (!isElectron()) return;
    await cancelDownloadJob(jobId);
    this._speedSamples.delete(jobId);
    await this.refresh();
  }

  /** Resume an interrupted/paused/errored job — the engine continues from .part. */
  async resumeJob(job: DownloadJob) {
    if (!isElectron()) return;
    const modelsDir = await getModelsDirPath();
    const destRel = job.dest_path.includes(modelsDir)
      ? job.dest_path.slice(modelsDir.length).replace(/^[/\\]+/, '')
      : undefined;
    await startDownloadHf({
      repo_id: job.repo_id,
      file: job.file,
      models_dir: modelsDir,
      dest_rel: destRel,
      load_when_ready: job.load_when_ready
    });
    this.startPolling();
    await this.refresh();
  }

  async retryJob(jobId: string) {
    if (!isElectron()) return;
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    const modelsDir = await getModelsDirPath();
    await retryDownloadJob(job, modelsDir);
    this.startPolling();
    await this.refresh();
  }
}

export const downloadsStore = new DownloadsStore();
