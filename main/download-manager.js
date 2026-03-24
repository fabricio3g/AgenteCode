import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { getAppPaths, getMainWindow } from './index.js';

const downloadJobs = new Map();

function fetchWithRetry(url, opts = {}) {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeout_ms ?? 30000;
  const method = (opts.method || 'GET').toUpperCase();

  return (async () => {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { ...opts, method, signal: ctrl.signal, redirect: 'follow' });
        clearTimeout(t);
        // Retry on 429 (rate limited) with exponential backoff
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, i), 30000);
          if (i < retries) {
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
        }
        return resp;
      } catch (err) {
        clearTimeout(t);
        lastErr = err;
        if (i >= retries) throw lastErr;
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
      }
    }
    throw lastErr;
  })();
}

function emitDownloadProgress(job) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('download-progress', job);
  }
}

export async function startDownloadHf({ repoId, file, modelsDir, destRel, hfToken, branch }) {
  const paths = getAppPaths();
  const targetDir = modelsDir || paths.localModelsRoot;
  const relativeDest = destRel || file;
  const destPath = path.join(targetDir, relativeDest);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const branchRef = branch || 'main';
  const encodedFile = file.split('/').map(s => encodeURIComponent(s)).join('/');
  const url = `https://huggingface.co/${repoId}/resolve/${branchRef}/${encodedFile}`;

  const jobId = randomUUID();
  const job = {
    id: jobId,
    kind: 'hf_model',
    model_id: repoId.split('/').pop() || repoId,
    repo_id: repoId,
    file,
    url,
    dest_path: destPath,
    total_bytes: 0,
    downloaded_bytes: 0,
    progress: 0,
    status: 'running',
    error: null,
    timestamp: Date.now(),
    label: file,
    etag: null,
    last_modified: null,
    expected_sha256: null,
    verified: false
  };

  downloadJobs.set(jobId, job);
  emitDownloadProgress(job);

  // Start download in background
  downloadInBackground(job, hfToken).catch(err => {
    job.status = 'error';
    job.error = err.message;
    emitDownloadProgress(job);
  });

  return jobId;
}

async function downloadInBackground(job, hfToken) {
  const headers = {};
  if (hfToken) headers.Authorization = `Bearer ${hfToken}`;

  // HuggingFace LFS: first request returns a 302 redirect to a CDN URL.
  // We follow it manually so we can strip the Authorization header before
  // hitting the CDN (CDNs reject requests with Bearer tokens from HF).
  let resp = await fetchWithRetry(job.url, {
    headers,
    timeout_ms: 60000,
    retries: 3,
    redirect: 'manual'
  });

  // Follow up to 5 redirects manually, stripping auth on cross-origin hops
  let redirectCount = 0;
  let currentUrl = job.url;
  while ((resp.status === 301 || resp.status === 302 || resp.status === 307 || resp.status === 308) && redirectCount < 5) {
    const location = resp.headers.get('location');
    if (!location) break;
    redirectCount++;
    const redirectUrl = new URL(location, currentUrl).toString();
    const isCrossOrigin = new URL(redirectUrl).hostname !== new URL(currentUrl).hostname;
    const redirectHeaders = isCrossOrigin ? {} : headers;
    resp = await fetchWithRetry(redirectUrl, {
      headers: redirectHeaders,
      timeout_ms: 60000,
      retries: 3,
      redirect: 'manual'
    });
    currentUrl = redirectUrl;
  }

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}${resp.status === 401 ? ' (unauthorized — check HuggingFace token)' : resp.status === 403 ? ' (forbidden — model may require access request)' : ''}`);
  }

  const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);
  job.total_bytes = totalBytes;
  job.etag = resp.headers.get('etag');
  job.last_modified = resp.headers.get('last-modified');

  const tempPath = job.dest_path + '.part';
  const writeStream = fs.createWriteStream(tempPath);
  const hash = createHash('sha256');
  let downloaded = 0;
  let lastEmit = 0;

  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      hash.update(chunk);
      job.downloaded_bytes = downloaded;
      job.progress = totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0;

      const now = Date.now();
      if (now - lastEmit > 500) {
        lastEmit = now;
        emitDownloadProgress(job);
      }
      callback(null, chunk);
    }
  });

  await pipeline(resp.body, progress, writeStream);

  // Rename temp to final
  fs.renameSync(tempPath, job.dest_path);

  job.status = 'completed';
  job.progress = 100;
  job.downloaded_bytes = downloaded;
  job.verified = true;
  emitDownloadProgress(job);
}

export async function getDownloadJobs() {
  return Array.from(downloadJobs.values());
}

export async function cancelDownloadJob(jobId) {
  const job = downloadJobs.get(jobId);
  if (job) {
    job.status = 'cancelled';
    emitDownloadProgress(job);
  }
}

export async function pauseDownloadJob(jobId) {
  const job = downloadJobs.get(jobId);
  if (job) {
    job.status = 'paused';
    emitDownloadProgress(job);
  }
}

export async function clearFinishedDownloads() {
  for (const [id, job] of downloadJobs) {
    if (['completed', 'cancelled', 'error'].includes(job.status)) {
      downloadJobs.delete(id);
    }
  }
}

export async function removeDownloadJob(id) {
  downloadJobs.delete(id);
}
