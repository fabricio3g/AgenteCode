import type { IpcMain } from 'electron';

type DownloadHandlerDeps = {
  ipcMain: IpcMain;
  startDownloadHf: (args: unknown) => unknown;
  getDownloadJobs: () => unknown;
  cancelDownloadJob: (jobId: string) => unknown;
  pauseDownloadJob: (jobId: string) => unknown;
  clearFinishedDownloads: () => unknown;
  removeDownloadJob: (id: string) => unknown;
};

export function registerDownloadHandlers({
  ipcMain,
  startDownloadHf,
  getDownloadJobs,
  cancelDownloadJob,
  pauseDownloadJob,
  clearFinishedDownloads,
  removeDownloadJob,
}: DownloadHandlerDeps): void {
  ipcMain.handle('start_download_hf', (_e, args) => startDownloadHf(args));
  ipcMain.handle('get_download_jobs', () => getDownloadJobs());
  ipcMain.handle('cancel_download_job', (_e, { jobId }) => cancelDownloadJob(jobId));
  ipcMain.handle('pause_download_job', (_e, { jobId }) => pauseDownloadJob(jobId));
  ipcMain.handle('clear_finished_downloads', () => clearFinishedDownloads());
  ipcMain.handle('remove_download_job', (_e, { id }) => removeDownloadJob(id));
}
