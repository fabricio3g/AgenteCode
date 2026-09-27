import type { DownloadJob } from '$lib/types/bridge';
import { invoke } from './bridge';
import { getStoredHfToken } from './huggingface';

type StartDownloadArgs = {
  repo_id?: string;
  repoId?: string;
  file: string;
  models_dir?: string;
  modelsDir?: string;
  dest_rel?: string;
  destRel?: string;
  hf_token?: string;
  hfToken?: string;
  branch?: string;
  /** Opt-in: run the local-model load flow when the download completes. */
  load_when_ready?: boolean;
  loadWhenReady?: boolean;
};

export async function startDownloadHf(args: StartDownloadArgs): Promise<string> {
  // The IPC layer expects camelCase keys (e.g. repoId, modelsDir).
  // Accept both snake_case and camelCase here for compatibility with existing call sites.
  const payload: Record<string, unknown> = {
    repoId: args.repoId ?? args.repo_id,
    file: args.file,
    modelsDir: args.modelsDir ?? args.models_dir,
    destRel: args.destRel ?? args.dest_rel,
    hfToken: args.hfToken ?? args.hf_token ?? getStoredHfToken(),
    branch: args.branch,
    loadWhenReady: args.loadWhenReady ?? args.load_when_ready
  };
  return invoke<string>('start_download_hf', payload);
}

export async function getDownloadJobs(): Promise<DownloadJob[]> {
  return invoke<DownloadJob[]>('get_download_jobs');
}

export async function cancelDownloadJob(id: string): Promise<void> {
  // The handler expects jobId in camelCase
  await invoke<void>('cancel_download_job', { jobId: id });
}

export async function pauseDownloadJob(id: string): Promise<void> {
  await invoke<void>('pause_download_job', { jobId: id });
}

export async function clearFinishedDownloads(): Promise<void> {
  await invoke<void>('clear_finished_downloads');
}

export async function removeDownloadJob(id: string): Promise<void> {
  // remove_download_job expects `id` as the parameter name on the Rust side
  await invoke<void>('remove_download_job', { id });
}

export async function retryDownloadJob(job: DownloadJob, modelsDir: string): Promise<string> {
  await removeDownloadJob(job.id);
  const destRel = job.dest_path.includes(modelsDir)
    ? job.dest_path.slice(modelsDir.length).replace(/^[/\\]+/, '')
    : undefined;
  return startDownloadHf({
    repo_id: job.repo_id,
    file: job.file,
    models_dir: modelsDir,
    dest_rel: destRel,
  });
}
