import type { DownloadJob } from '$lib/types/tauri';
import { clearFinishedDownloads, getDownloadJobs, removeDownloadJob, retryDownloadJob } from '$lib/services/downloads';
import { getModelsDirPath } from '$lib/services/models';
import { isTauri } from '$lib/services/tauri';

const ACTIVE_STATUSES = new Set(['starting', 'running']);
const POLL_INTERVAL_MS = 1000;
const EMA_ALPHA = 0.3;

interface SpeedSample {
  bytesAtLastSample: number;
  timeAtLastSample: number;
  speedBps: number;
}

export interface JobSpeed {
  speedBps: number;
  etaSeconds: number;
}

class DownloadsStore {
  jobs = $state<DownloadJob[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  private _pollerHandle: ReturnType<typeof setInterval> | null = null;
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
    if (!isTauri()) {
      this.jobs = [];
      return;
    }

    this.loading = true;
    this.error = null;
    try {
      this.jobs = await getDownloadJobs();
    } catch (error) {
      this.jobs = [];
      this.error = String((error as Error)?.message || error || 'Failed to load downloads');
    } finally {
      this.loading = false;
    }

    this._syncPoller();
  }

  /** Start polling when there are active downloads, stop when idle. */
  startPolling() {
    if (this._pollerHandle !== null) return;
    this._pollerHandle = setInterval(() => void this._pollTick(), POLL_INTERVAL_MS);
  }

  stopPolling() {
    if (this._pollerHandle !== null) {
      clearInterval(this._pollerHandle);
      this._pollerHandle = null;
    }
  }

  private async _pollTick() {
    if (!isTauri()) return;
    try {
      this.jobs = await getDownloadJobs();
    } catch {
      // ignore transient poll errors
      return;
    }
    this._updateSpeedSamples();
    this._syncPoller();
  }

  private _updateSpeedSamples() {
    const now = Date.now();
    const currentJobIds = new Set(this.jobs.map((j) => j.id));

    // Clean up samples for jobs no longer present
    for (const id of this._speedSamples.keys()) {
      if (!currentJobIds.has(id)) this._speedSamples.delete(id);
    }

    for (const job of this.jobs) {
      if (job.status !== 'running') {
        this._speedSamples.delete(job.id);
        continue;
      }

      const prev = this._speedSamples.get(job.id);
      if (!prev) {
        // First sample – seed with current values, speed unknown
        this._speedSamples.set(job.id, {
          bytesAtLastSample: job.downloaded_bytes,
          timeAtLastSample: now,
          speedBps: 0
        });
        continue;
      }

      const dt = (now - prev.timeAtLastSample) / 1000; // seconds
      if (dt <= 0) continue;

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
  }

  private _syncPoller() {
    if (this.hasActive) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  async clearFinished() {
    if (!isTauri()) return;
    await clearFinishedDownloads();
    await this.refresh();
  }

  async removeJob(jobId: string) {
    if (!isTauri()) return;
    await removeDownloadJob(jobId);
    this._speedSamples.delete(jobId);
    await this.refresh();
  }

  async retryJob(jobId: string) {
    if (!isTauri()) return;
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    const modelsDir = await getModelsDirPath();
    await retryDownloadJob(job, modelsDir);
    this.startPolling();
    await this.refresh();
  }
}

export const downloadsStore = new DownloadsStore();
