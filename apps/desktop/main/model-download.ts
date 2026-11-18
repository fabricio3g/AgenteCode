// ── Model download engine ──────────────────────────────────────────────
// Real downloads: cancellable, pausable, resumable across restarts.
//
// Contract with llama.cpp-world reality:
// - GGUF files come from Hugging Face via LFS redirects; auth must be
//   stripped on cross-origin hops (CDNs reject HF bearer tokens).
// - Large models ship as shards (`-00001-of-00003.gguf`); a download is a
//   group of ordered files, not one file.
// - Interrupted transfers resume from `.part` with `Range` + `If-Range`, so
//   an etag change restarts cleanly instead of corrupting the file.
//
// State lives in `downloads.json` next to the app config, so jobs survive
// an app restart: running jobs come back as `interrupted` and are resumable.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { getAppPaths } from './paths.ts';
import { getMainWindow } from './window-manager.ts';
import { readGgufMetadataFields } from './runtime-config-resolver.ts';
import { sidecarTemplatePath } from './chat-templates.ts';
import {
  aggregateProgress,
  applyResumeResponse,
  checkDiskSpace,
  expandShards,
  planResume
} from './download-planning.ts';

export type DownloadStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'cancelled'
  | 'error';

/** What a download is, for the download manager's icon and grouping. */
export type DownloadCategory = 'chat' | 'speech' | 'voice' | 'engine';

export interface DownloadJob {
  id: string;
  /** hf_model: resumable model files. file: a one-off (engine, speech model). */
  kind: 'hf_model' | 'file';
  category?: DownloadCategory;
  model_id: string;
  repo_id: string;
  /** Primary file (first shard). Kept as `file` for renderer compatibility. */
  file: string;
  /** Every file this job must fetch, in order — usually [file]. */
  files: string[];
  url: string;
  dest_path: string;
  total_bytes: number;
  downloaded_bytes: number;
  progress: number;
  status: DownloadStatus;
  error: string | null;
  timestamp: number;
  label: string;
  etag: string | null;
  last_modified: string | null;
  verified: boolean;
  /** When true, a completed job triggers the local-model load flow. */
  load_when_ready?: boolean;
}

interface ShardState {
  file: string;
  destPath: string;
  partPath: string;
  url: string;
  sizeBytes: number;
  doneBytes: number;
  complete: boolean;
}

const jobs = new Map<string, DownloadJob>();
const controllers = new Map<string, AbortController>();
const shardStates = new Map<string, ShardState[]>();

let registryPath: string | null = null;
let persistTimer: NodeJS.Timeout | null = null;
/** Set by IPC wiring: called with the model path when a `load_when_ready` job completes. */
let autoLoadHandler: ((modelPath: string) => void) | null = null;

export function setAutoLoadHandler(fn: (modelPath: string) => void): void {
  autoLoadHandler = fn;
}

// ── Registry persistence ───────────────────────────────────────────────

function getRegistryPath(): string {
  if (!registryPath) registryPath = path.join(getAppPaths().appData, 'downloads.json');
  return registryPath;
}

function persistRegistry(): void {
  // Progress ticks arrive many times a second; coalesce them.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const payload = Array.from(jobs.values()).map((job) => ({
        ...job,
        __shards: (shardStates.get(job.id) || []).map((s) => ({
          file: s.file,
          doneBytes: s.doneBytes,
          complete: s.complete
        }))
      }));
      fs.mkdirSync(path.dirname(getRegistryPath()), { recursive: true });
      fs.writeFileSync(getRegistryPath(), JSON.stringify(payload, null, 2));
    } catch {
      // A failed registry write must never take a download down.
    }
  }, 800);
}

export function restorePersistedJobs(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(getRegistryPath(), 'utf8');
  } catch {
    return;
  }
  let entries: Array<DownloadJob & { __shards?: Array<{ file: string; doneBytes: number; complete: boolean }> }>;
  try {
    entries = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    if (!entry?.id || !entry.dest_path) continue;
    const wasActive = entry.status === 'running' || entry.status === 'queued' || entry.status === 'starting';
    const job: DownloadJob = {
      ...entry,
      status: wasActive ? 'interrupted' : entry.status,
      error: wasActive ? 'The app restarted while downloading.' : entry.error
    };
    jobs.set(job.id, job);
    const saved = entry.__shards || [];
    shardStates.set(
      job.id,
      (job.files?.length ? job.files : [job.file]).map((file) => {
        const destPath = path.join(path.dirname(job.dest_path), file);
        const prior = saved.find((s) => s.file === file);
        return {
          file,
          destPath,
          partPath: destPath + '.part',
          url: shardUrl(job.url, job.file, file),
          sizeBytes: 0,
          doneBytes: prior?.doneBytes ?? 0,
          complete: !!prior?.complete
        };
      })
    );
  }
}

/** Rebuild a per-shard URL when the job's primary file differs from the shard. */
function shardUrl(primaryUrl: string, primaryFile: string, file: string): string {
  if (file === primaryFile) return primaryUrl;
  return primaryUrl.replace(encodeURIComponent(primaryFile), encodeURIComponent(file))
    .replace(primaryFile, file);
}

// ── Helpers ────────────────────────────────────────────────────────────

function emit(job: DownloadJob): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('download-progress', publicJob(job));
  }
}

function publicJob(job: DownloadJob): DownloadJob {
  return { ...job };
}

function aggregate(job: DownloadJob): void {
  const shards = shardStates.get(job.id) || [];
  const totals = aggregateProgress(shards);
  job.downloaded_bytes = totals.downloadedBytes;
  job.total_bytes = totals.totalBytes;
  job.progress = totals.progress;
}

function setStatus(job: DownloadJob, status: DownloadStatus, error: string | null = null): void {
  job.status = status;
  job.error = error;
  emit(job);
  persistRegistry();
}

async function fetchWithRetry(url: string, opts: Parameters<typeof fetch>[1] & { retries?: number; timeout_ms?: number } = {}) {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeout_ms ?? 30000;
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const externalSignal = opts.signal as AbortSignal | undefined;
    const onAbort = () => ctrl.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    try {
      const resp = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(timer);
      if (resp.status === 429 && i < retries) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
        await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** i, 30000)));
        continue;
      }
      return resp;
    } catch (err: unknown) {
      clearTimeout(timer);
      // A user-initiated abort must surface immediately, not retry.
      if (externalSignal?.aborted) throw err;
      lastErr = err;
      if (i >= retries) throw lastErr;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    } finally {
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

/** Follow LFS redirects manually, stripping Authorization on cross-origin hops. */
async function resolveRedirects(url: string, headers: Record<string, string>, signal: AbortSignal, method = 'GET') {
  let currentUrl = url;
  let resp = await fetchWithRetry(currentUrl, { headers, timeout_ms: 60000, signal, method });
  for (let hops = 0; hops < 5; hops++) {
    if (![301, 302, 307, 308].includes(resp.status)) break;
    const location = resp.headers.get('location');
    if (!location) break;
    const nextUrl = new URL(location, currentUrl).toString();
    const crossOrigin = new URL(nextUrl).hostname !== new URL(currentUrl).hostname;
    resp = await fetchWithRetry(nextUrl, {
      headers: crossOrigin ? {} : headers,
      timeout_ms: 60000,
      signal,
      method
    });
    currentUrl = nextUrl;
  }
  return resp;
}

async function freeDiskBytes(dir: string): Promise<number> {
  try {
    const stats = await fs.promises.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ── Public API (IPC surface unchanged) ─────────────────────────────────

/**
 * Pull the model's own chat template from Hugging Face and store it next to
 * the GGUF as a sidecar (`<model>.chat-template.jinja`). Many re-quants drop
 * `tokenizer.chat_template`; without it llama-server renders a generic shell
 * where thinking cannot be toggled and tool calls never parse.
 *
 * Quant repos usually carry no tokenizer files at all, so after the repo
 * itself the *base model* repo is tried (`cardData.base_model` /
 * `base_model` from the Hub API) — that is where `tokenizer_config.json`
 * with the training-time template lives.
 *
 * Sources, in order: `chat_template.jinja` (new convention), then
 * `tokenizer_config.json.chat_template` (string or a `{default, tool_use}`
 * map — `default` is the one the server uses).
 *
 * Best-effort: missing or private files just leave the model on the
 * family/generic fallback, so callers never fail a download over this.
 */
async function captureRepoChatTemplate(
  repoId: string,
  modelPath: string,
  options: { hfToken?: string; branch?: string } = {}
): Promise<{ written: boolean; source: string | null; repo: string | null }> {
  const headers: Record<string, string> = {};
  if (options.hfToken) headers.Authorization = `Bearer ${options.hfToken}`;

  const fetchText = async (url: string): Promise<string | null> => {
    try {
      const resp = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      });
      if (!resp.ok) return null;
      const text = (await resp.text()).trim();
      return text || null;
    } catch {
      return null;
    }
  };

  const extractFromTokenizerConfig = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { chat_template?: unknown };
      const template = parsed.chat_template;
      if (typeof template === 'string') return template.trim() || null;
      if (template && typeof template === 'object') {
        const map = template as Record<string, unknown>;
        for (const key of ['default', 'tool_use']) {
          if (typeof map[key] === 'string' && String(map[key]).trim()) return String(map[key]).trim();
        }
      }
    } catch {
      // not JSON — ignore
    }
    return null;
  };

  const captureFromRepo = async (repo: string): Promise<{ template: string; source: string } | null> => {
    const ref = options.branch || 'main';
    const base = `https://huggingface.co/${repo}/resolve/${ref}/`;
    const direct = await fetchText(`${base}chat_template.jinja`);
    if (direct) return { template: direct, source: 'chat_template.jinja' };
    const fromConfig = extractFromTokenizerConfig(await fetchText(`${base}tokenizer_config.json`));
    if (fromConfig) return { template: fromConfig, source: 'tokenizer_config.json' };
    return null;
  };

  /** Base-model repos the Hub records for this repo (card metadata or API). */
  const findBaseRepos = async (repo: string): Promise<string[]> => {
    const meta = await fetchText(`https://huggingface.co/api/models/${repo}`);
    if (!meta) return [];
    try {
      const parsed = JSON.parse(meta) as {
        cardData?: { base_model?: unknown };
        base_model?: unknown;
      };
      const raw = parsed.cardData?.base_model ?? parsed.base_model;
      const candidates: string[] = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
      // Entries may be tagged like "base_model:finetune:org/repo" — keep the repo id.
      return candidates
        .map((value) => value.split(':').pop() || '')
        .filter((value) => value.includes('/'))
        .slice(0, 2);
    } catch {
      return [];
    }
  };

  const own = await captureFromRepo(repoId);
  let found = own;
  let usedRepo = own ? repoId : null;
  if (!found) {
    for (const baseRepo of await findBaseRepos(repoId)) {
      if (baseRepo === repoId) continue;
      const fromBase = await captureFromRepo(baseRepo);
      if (fromBase) {
        found = fromBase;
        usedRepo = baseRepo;
        break;
      }
    }
  }
  if (!found || !usedRepo) return { written: false, source: null, repo: null };

  const destination = sidecarTemplatePath(modelPath);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, found.template, 'utf8');
    return { written: true, source: found.source, repo: usedRepo };
  } catch (err) {
    console.warn('[downloads] failed to store chat template sidecar:', err instanceof Error ? err.message : String(err));
    return { written: false, source: null, repo: null };
  }
}

/**
 * After a model download completes, capture the repo's chat template when
 * the GGUF itself did not embed one. Embedded templates stay authoritative —
 * they are what the checkpoint was trained with.
 */
async function ensureChatTemplateSidecar(job: DownloadJob, hfToken?: string): Promise<void> {
  if (!job.dest_path || !/\.gguf$/i.test(job.dest_path)) return;
  try {
    const fields = readGgufMetadataFields(job.dest_path);
    if (fields?.chat_template_present) return;
    const result = await captureRepoChatTemplate(job.repo_id, job.dest_path, { hfToken, branch: 'main' });
    if (result.written) {
      console.log(`[downloads] captured chat template from ${result.repo} (${result.source}) for ${path.basename(job.dest_path)}`);
    }
  } catch (err) {
    console.warn('[downloads] chat template capture skipped:', err instanceof Error ? err.message : String(err));
  }
}

export async function startDownloadHf({
  repoId,
  file,
  modelsDir,
  destRel,
  hfToken,
  branch,
  loadWhenReady
}: {
  repoId: string;
  file: string;
  modelsDir?: string;
  destRel?: string;
  hfToken?: string;
  branch?: string;
  loadWhenReady?: boolean;
}): Promise<string> {
  const paths = getAppPaths();
  const targetDir = modelsDir || paths.localModelsRoot;
  const relativeDest = destRel || file;
  const destDir = path.join(targetDir, path.dirname(relativeDest === file ? '' : relativeDest));
  const destPath = path.join(targetDir, relativeDest);

  // Resume instead of duplicating: an existing paused/interrupted/errored job
  // pointing at the same destination picks up where it left off.
  for (const existing of jobs.values()) {
    if (existing.dest_path !== destPath) continue;
    if (['paused', 'interrupted', 'error'].includes(existing.status)) {
      if (loadWhenReady !== undefined) existing.load_when_ready = loadWhenReady;
      void runJob(existing, hfToken);
      return existing.id;
    }
    if (['running', 'queued'].includes(existing.status)) return existing.id;
  }

  const branchRef = branch || 'main';
  const encodedFile = file.split('/').map((s) => encodeURIComponent(s)).join('/');
  const url = `https://huggingface.co/${repoId}/resolve/${branchRef}/${encodedFile}`;
  const files = expandShards(file);

  const job: DownloadJob = {
    id: randomUUID(),
    kind: 'hf_model',
    // Kokoro voices come through here too (Settings → Voice).
    category: /kokoro|piper|[\\/]voices[\\/]/i.test(`${repoId} ${destPath}`) ? 'voice' : 'chat',
    model_id: repoId.split('/').pop() || repoId,
    repo_id: repoId,
    file,
    files,
    url,
    dest_path: destPath,
    total_bytes: 0,
    downloaded_bytes: 0,
    progress: 0,
    status: 'queued',
    error: null,
    timestamp: Date.now(),
    label: file,
    etag: null,
    last_modified: null,
    verified: false,
    load_when_ready: !!loadWhenReady
  };

  shardStates.set(
    job.id,
    files.map((f) => {
      const finalPath = f === file ? destPath : path.join(destDir, f);
      return {
        file: f,
        destPath: finalPath,
        partPath: finalPath + '.part',
        url: f === file ? url : shardUrl(url, file, f),
        sizeBytes: 0,
        doneBytes: 0,
        complete: false
      };
    })
  );

  jobs.set(job.id, job);
  emit(job);
  persistRegistry();

  // Disk preflight before spending any bytes: sum expected sizes from HEAD
  // requests and compare against free space on the target volume.
  try {
    const ctrl = new AbortController();
    controllers.set(job.id, ctrl);
    let expected = 0;
    for (const shard of shardStates.get(job.id)!) {
      if (shard.complete) continue;
      const head = await resolveRedirects(shard.url, hfToken ? { Authorization: `Bearer ${hfToken}` } : {}, ctrl.signal, 'HEAD');
      if (!head.ok && head.status !== 405) throw new Error(`HTTP ${head.status} while checking ${shard.file}`);
      const len = parseInt(head.headers.get('content-length') || '0', 10)
        || Number((head.headers.get('x-linked-size') || '0'));
      shard.sizeBytes = len;
      expected += Math.max(0, len - shard.doneBytes);
    }
    job.etag = null;
    const free = await freeDiskBytes(destDir);
    const spaceError = checkDiskSpace({ expectedRemainingBytes: expected, freeBytes: free });
    if (spaceError) throw new Error(spaceError);
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') return job.id;
    controllers.delete(job.id);
    setStatus(job, 'error', err instanceof Error ? err.message : String(err));
    return job.id;
  }

  void runJob(job, hfToken);
  return job.id;
}

async function runJob(job: DownloadJob, hfToken?: string): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(job.id, ctrl);
  setStatus(job, 'running');

  const headersBase: Record<string, string> = {};
  if (hfToken) headersBase.Authorization = `Bearer ${hfToken}`;

  try {
    for (const shard of shardStates.get(job.id) || []) {
      if (shard.complete || ctrl.signal.aborted) continue;
      await downloadShard(job, shard, headersBase, ctrl.signal);
    }

    if (ctrl.signal.aborted) return; // pause/cancel already set the status

    // All shards landed — finalize and verify sizes.
    const shards = shardStates.get(job.id) || [];
    for (const shard of shards) {
      if (!shard.complete) throw new Error(`Shard missing after download: ${shard.file}`);
      const size = fs.existsSync(shard.destPath) ? fs.statSync(shard.destPath).size : 0;
      if (shard.sizeBytes > 0 && size !== shard.sizeBytes) {
        throw new Error(`Size mismatch for ${shard.file}: got ${size}, expected ${shard.sizeBytes}`);
      }
    }

    // Capture the hub's chat template before marking complete so the very
    // first load already renders with the model's real template.
    await ensureChatTemplateSidecar(job, hfToken);

    job.verified = true;
    aggregate(job);
    setStatus(job, 'completed');

    if (job.load_when_ready && autoLoadHandler) {
      try {
        autoLoadHandler(job.dest_path);
      } catch (err: unknown) {
        console.warn('[downloads] auto-load failed:', err);
      }
    }
  } catch (err: unknown) {
    if (ctrl.signal.aborted) return;
    setStatus(job, 'error', err instanceof Error ? err.message : String(err));
  } finally {
    controllers.delete(job.id);
  }
}

async function downloadShard(
  job: DownloadJob,
  shard: ShardState,
  headersBase: Record<string, string>,
  signal: AbortSignal
): Promise<void> {
  fs.mkdirSync(path.dirname(shard.partPath), { recursive: true });

  // Resume position: whatever is already in the .part file, etag-guarded.
  let partSize = 0;
  try {
    partSize = fs.existsSync(shard.partPath) ? fs.statSync(shard.partPath).size : 0;
  } catch {
    partSize = 0;
  }

  let plan = planResume({ partSize, storedEtag: job.etag });
  const resp = await resolveRedirects(shard.url, { ...headersBase, ...plan.headers }, signal);
  if (!resp.ok) {
    const hint = resp.status === 401
      ? ' (unauthorized — check Hugging Face token)'
      : resp.status === 403
        ? ' (forbidden — the model may require an access request)'
        : '';
    throw new Error(`Download failed: HTTP ${resp.status}${hint}`);
  }

  // A non-206 answer to a range request means the etag changed or ranges are
  // unsupported — restart cleanly instead of splicing mismatched bytes.
  plan = applyResumeResponse(plan, resp.status);
  const offset = plan.offset;

  const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
  shard.sizeBytes = offset + contentLength || shard.sizeBytes;
  if (resp.headers.get('etag')) job.etag = resp.headers.get('etag');
  if (resp.headers.get('last-modified')) job.last_modified = resp.headers.get('last-modified');

  shard.doneBytes = offset;
  const hash = createHash('sha256');
  let lastEmit = 0;

  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      shard.doneBytes += chunk.length;
      hash.update(chunk);
      aggregate(job);
      const now = Date.now();
      if (now - lastEmit > 500) {
        lastEmit = now;
        emit(job);
        persistRegistry();
      }
      callback(null, chunk);
    }
  });

  const writeStream = fs.createWriteStream(shard.partPath, { flags: plan.writeMode === 'append' ? 'append' : 'w' });
  await pipeline(resp.body, progress, writeStream);

  fs.renameSync(shard.partPath, shard.destPath);
  shard.complete = true;
  aggregate(job);
  emit(job);
  persistRegistry();
}

/**
 * A one-off download (an engine archive, a speech model) shown in the
 * download manager next to model downloads. Cancelling it from the manager
 * aborts the transfer; the caller sees the rejection.
 */
export async function trackDownload(
  { url, dest, label, category }: { url: string; dest: string; label: string; category: DownloadCategory },
  onFraction: (fraction: number) => void = () => {}
): Promise<void> {
  const id = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const job: DownloadJob = {
    id, kind: 'file', category, model_id: label, repo_id: '', file: path.basename(dest), files: [path.basename(dest)],
    url, dest_path: dest, total_bytes: 0, downloaded_bytes: 0, progress: 0, status: 'running', error: null,
    timestamp: Date.now(), label, etag: null, last_modified: null, verified: false
  };
  const controller = new AbortController();
  jobs.set(id, job);
  controllers.set(id, controller);
  emit(job);
  persistRegistry();

  let lastEmit = 0;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok || !resp.body) throw new Error(`Download failed: HTTP ${resp.status}`);
    job.total_bytes = Number(resp.headers.get('content-length') || 0);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        job.downloaded_bytes += value.length;
        job.progress = job.total_bytes ? job.downloaded_bytes / job.total_bytes : 0;
        onFraction(job.progress);
        if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); emit(job); }
      }
    } finally {
      await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
    }
    job.progress = 1;
    setStatus(job, 'completed');
  } catch (err) {
    if (controller.signal.aborted) {
      if (job.status !== 'cancelled') setStatus(job, 'cancelled');
      throw new Error('Download cancelled.');
    }
    setStatus(job, 'error', err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    controllers.delete(id);
  }
}

export async function getDownloadJobs(): Promise<DownloadJob[]> {
  return Array.from(jobs.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export async function pauseDownloadJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job || !['running', 'queued'].includes(job.status)) return;
  controllers.get(jobId)?.abort(new Error('paused'));
  controllers.delete(jobId);
  setStatus(job, 'paused');
}

export async function cancelDownloadJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  controllers.get(jobId)?.abort(new Error('cancelled'));
  controllers.delete(jobId);
  // Cancel means clean: partial bytes go away so a later start starts fresh.
  for (const shard of shardStates.get(jobId) || []) {
    try { fs.rmSync(shard.partPath, { force: true }); } catch { /* best effort */ }
  }
  if (job.kind === 'file') {
    try { fs.rmSync(job.dest_path, { force: true }); } catch { /* best effort */ }
  }
  setStatus(job, 'cancelled');
}

export async function clearFinishedDownloads(): Promise<void> {
  for (const [id, job] of jobs) {
    if (['completed', 'cancelled', 'error'].includes(job.status)) {
      jobs.delete(id);
      shardStates.delete(id);
    }
  }
  persistRegistry();
}

export async function removeDownloadJob(id: string): Promise<void> {
  jobs.delete(id);
  shardStates.delete(id);
  persistRegistry();
}
