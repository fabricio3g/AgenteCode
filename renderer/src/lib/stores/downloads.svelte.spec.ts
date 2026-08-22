import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetDownloadJobs = vi.fn();
const mockClearFinishedDownloads = vi.fn();

vi.mock('$lib/services/bridge', () => ({
  isElectron: () => true
}));

vi.mock('$lib/services/downloads', () => ({
  getDownloadJobs: () => mockGetDownloadJobs(),
  clearFinishedDownloads: () => mockClearFinishedDownloads()
}));

describe('DownloadsStore', () => {
  let downloadsStore: Awaited<typeof import('./downloads.svelte')>['downloadsStore'];

  const mockJob = (overrides: Record<string, unknown>) => overrides as unknown as typeof downloadsStore.jobs[number];
  const storeInternals = () => downloadsStore as unknown as {
    _syncPoller: () => void;
    _pollerHandle: ReturnType<typeof setInterval> | null;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    
    const module = await import('./downloads.svelte');
    downloadsStore = module.downloadsStore;
    downloadsStore.stopPolling();
    downloadsStore.jobs = [];
    downloadsStore.error = null;
  });

  describe('hasActive', () => {
    it('returns false when no jobs', () => {
      downloadsStore.jobs = [];
      expect(downloadsStore.hasActive).toBe(false);
    });

    it('returns true when starting job exists', () => {
      downloadsStore.jobs = [mockJob({ id: '1', status: 'starting' })];
      expect(downloadsStore.hasActive).toBe(true);
    });

    it('returns true when running job exists', () => {
      downloadsStore.jobs = [mockJob({ id: '1', status: 'running' })];
      expect(downloadsStore.hasActive).toBe(true);
    });

    it('returns false when only completed jobs', () => {
      downloadsStore.jobs = [mockJob({ id: '1', status: 'done' })];
      expect(downloadsStore.hasActive).toBe(false);
    });
  });

  describe('activeCount', () => {
    it('counts active jobs', () => {
      downloadsStore.jobs = [
        mockJob({ id: '1', status: 'starting' }),
        mockJob({ id: '2', status: 'running' }),
        mockJob({ id: '3', status: 'done' })
      ];
      expect(downloadsStore.activeCount).toBe(2);
    });
  });

  describe('jobFor', () => {
    it('finds job by repo and file', () => {
      downloadsStore.jobs = [
        mockJob({ id: '1', repo_id: 'owner/repo', file: 'model.gguf' })
      ];
      const job = downloadsStore.jobFor('owner/repo', 'model.gguf');
      expect(job?.id).toBe('1');
    });

    it('returns undefined if not found', () => {
      downloadsStore.jobs = [];
      const job = downloadsStore.jobFor('owner/repo', 'model.gguf');
      expect(job).toBeUndefined();
    });
  });

  describe('refresh', async () => {
    it('fetches jobs from backend', async () => {
      const mockJobs = [
        { id: '1', status: 'running', progress: 50 }
      ];
      mockGetDownloadJobs.mockResolvedValue(mockJobs);

      await downloadsStore.refresh();

      expect(mockGetDownloadJobs).toHaveBeenCalled();
      expect(downloadsStore.jobs).toEqual(mockJobs);
    });

    it('handles errors gracefully', async () => {
      mockGetDownloadJobs.mockRejectedValue(new Error('Network error'));

      await downloadsStore.refresh();

      expect(downloadsStore.jobs).toEqual([]);
      expect(downloadsStore.error).toBeTruthy();
    });
  });

  describe('clearFinished', async () => {
    it('calls backend and refreshes', async () => {
      mockClearFinishedDownloads.mockResolvedValue(undefined);
      mockGetDownloadJobs.mockResolvedValue([]);

      await downloadsStore.clearFinished();

      expect(mockClearFinishedDownloads).toHaveBeenCalled();
      expect(mockGetDownloadJobs).toHaveBeenCalled();
    });
  });

  describe('polling', () => {
    it('starts polling when active jobs exist', () => {
      const internals = storeInternals();
      downloadsStore.jobs = [mockJob({ id: '1', status: 'running' })];
      internals._syncPoller();
      expect(internals._pollerHandle).not.toBeNull();
      downloadsStore.stopPolling();
    });

    it('stops polling when no active jobs', () => {
      const internals = storeInternals();
      internals._pollerHandle = setInterval(() => {}, 999999);
      downloadsStore.jobs = [mockJob({ id: '1', status: 'done' })];
      internals._syncPoller();
      expect(internals._pollerHandle).toBeNull();
    });
  });
});
