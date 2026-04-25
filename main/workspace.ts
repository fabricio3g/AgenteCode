import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import extract from 'extract-zip';
import * as tar from 'tar';
import { shell, dialog } from 'electron';
import { getAppPaths } from './index.ts';
import { ingestText, queryDocuments as queryRagDocuments, listRagDocuments, removeRagDocument, clearRagDocuments } from './rag-engine.ts';

const ALLOWED_WORKSPACE_COMMANDS = new Set([
  'node', 'npm', 'npx', 'python', 'python3', 'python2', 'pip', 'pip3',
  'ruby', 'gem', 'cargo', 'rustc', 'go', 'java', 'javac', 'make', 'cmake',
  'bash', 'sh', 'dash', 'zsh', 'perl', 'php', 'lua', 'R', 'rscript',
  'git', 'curl', 'wget', 'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'cat', 'head', 'tail', 'grep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc',
  'jq', 'pandoc', 'docker', 'docker-compose', 'podman',
  'chmod', 'chown', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'ls', 'pwd', 'cd', 'echo',
  'pandoc', 'latex', 'pdflatex', 'xelatex', 'lualatex'
]);

function isWorkspaceCommandAllowed(cmd) {
  const base = path.basename(cmd).toLowerCase().replace(/-/g, '');
  if (ALLOWED_WORKSPACE_COMMANDS.has(base)) return true;
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  return ALLOWED_WORKSPACE_COMMANDS.has(cmd.toLowerCase());
}

export async function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

export async function openModelsFolder() {
  const paths = getAppPaths();
  fs.mkdirSync(paths.localModelsRoot, { recursive: true });
  shell.openPath(paths.localModelsRoot);
}

export async function pickWorkspaceFolder() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

export async function pickModelFile() {
  const result = await dialog.showOpenDialog({
    title: 'Select a GGUF Model File',
    properties: ['openFile'],
    filters: [
      { name: 'GGUF Models', extensions: ['gguf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

export async function indexWorkspaceFolder(folderPath, chatId) {
  const rootName = path.basename(folderPath);
  const files = [];
  let indexedCount = 0;
  let skippedCount = 0;

  function walk(dir, rel = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files and common non-useful directories
      if (entry.name.startsWith('.')) continue;
      if (['node_modules', '__pycache__', '.git', 'dist', 'build', 'target'].includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const stat = fs.statSync(fullPath);
      const ext = path.extname(entry.name).toLowerCase();
      const textExts = ['.js', '.ts', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
        '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.svelte',
        '.vue', '.jsx', '.tsx', '.rb', '.php', '.sh', '.bat', '.ps1', '.sql',
        '.xml', '.csv', '.ini', '.cfg', '.env'];

      if (!textExts.includes(ext) || stat.size > 1024 * 1024) {
        files.push({
          path: relPath, name: entry.name, size: stat.size,
          type: ext.slice(1) || 'unknown', status: 'skipped', reason: 'unsupported_type'
        });
        skippedCount++;
        continue;
      }

      files.push({
        path: relPath, name: entry.name, size: stat.size,
        type: ext.slice(1) || 'text', status: 'ready'
      });
      indexedCount++;
    }
  }

  try {
    walk(folderPath);
  } catch (err) {
    return {
      root_path: folderPath, root_name: rootName,
      file_count: 0, indexed_count: 0, skipped_count: 0, files: [],
      error: err.message
    };
  }

  return {
    root_path: folderPath,
    root_name: rootName,
    file_count: files.length,
    indexed_count: indexedCount,
    skipped_count: skippedCount,
    files
  };
}

export async function writeWorkspaceFile(workspaceRoot, relativePath, content) {
  const fullPath = path.join(workspaceRoot, relativePath);
  // Prevent path traversal
  if (!fullPath.startsWith(workspaceRoot)) throw new Error('Path traversal not allowed');
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

export async function readWorkspaceFile(workspaceRoot, relativePath) {
  const fullPath = path.join(workspaceRoot, relativePath);
  if (!fullPath.startsWith(workspaceRoot)) throw new Error('Path traversal not allowed');
  return fs.readFileSync(fullPath, 'utf8');
}

export async function createWorkspaceDocument(workspaceRoot, relativePath, docType, content) {
  return writeWorkspaceFile(workspaceRoot, relativePath, content);
}

export async function renameWorkspaceFile(workspaceRoot, oldPath, newPath) {
  const oldFull = path.join(workspaceRoot, oldPath);
  const newFull = path.join(workspaceRoot, newPath);
  if (!oldFull.startsWith(workspaceRoot) || !newFull.startsWith(workspaceRoot)) {
    throw new Error('Path traversal not allowed');
  }
  fs.mkdirSync(path.dirname(newFull), { recursive: true });
  fs.renameSync(oldFull, newFull);
}

export async function deleteWorkspaceFile(workspaceRoot, relativePath) {
  const fullPath = path.join(workspaceRoot, relativePath);
  if (!fullPath.startsWith(workspaceRoot)) throw new Error('Path traversal not allowed');
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
}

export async function openWorkspaceFile(absolutePath) {
  shell.openPath(absolutePath);
}

export async function createWorkspaceFolder(workspaceRoot, relativePath) {
  const fullPath = path.join(workspaceRoot, relativePath);
  if (!fullPath.startsWith(workspaceRoot)) throw new Error('Path traversal not allowed');
  fs.mkdirSync(fullPath, { recursive: true });
}

export async function workspaceExec({ workspace_root, command, args: execArgs, cwd, shell: useShell, timeout_ms }) {
  if (!isWorkspaceCommandAllowed(command)) {
    return {
      cwd: workDir,
      stdout: '',
      stderr: `Command not allowed: ${command}. Allowed commands: ${[...ALLOWED_WORKSPACE_COMMANDS].join(', ')}`,
      exit_code: -1,
      timed_out: false,
      error: 'Command not in allowlist'
    };
  }

  const workDir = cwd || workspace_root;
  const timeoutMs = timeout_ms || 30000;
  const useLoginShell = useShell !== false;

  return new Promise((resolve) => {
    let proc;
    if (useLoginShell) {
      // Login shell ensures npm/node/python3/cargo are on PATH
      const joined = execArgs?.length
        ? `${command} ${execArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`
        : command;
      proc = spawn('sh', ['-lc', joined], {
        cwd: workDir,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      proc = spawn(command, execArgs || [], {
        cwd: workDir,
        shell: false,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        cwd: workDir,
        stdout,
        stderr,
        exit_code: code,
        timed_out: timedOut
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        cwd: workDir,
        stdout,
        stderr: stderr + '\n' + err.message,
        exit_code: -1,
        timed_out: false
      });
    });
  });
}

export async function writeTempFile(name, data) {
  const tmpDir = path.join(os.tmpdir(), 'chatealm');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, name);
  const buffer = Buffer.from(data);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export async function resetMediaPermissions() {
  // Electron handles media permissions differently from Tauri
  // This is mostly a no-op but we keep the interface
  return { removed: [], failed: [] };
}

export async function downloadRuntime({ download_url, asset_name, release_tag }, win = null) {
  const paths = getAppPaths();
  const destDir = path.join(paths.localBinVersionsRoot, `${release_tag}-${asset_name.replace(/\.(zip|tar\.gz|tgz)$/, '')}`);

  // Clean destination directory to avoid symlink conflicts from partial extractions
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  function emit(progress, phase) {
    try { win?.webContents?.send('runtime-download-progress', { progress, phase }); } catch { /* ignore */ }
  }

  emit(0, 'downloading');

  // Download the archive with streaming progress
  const resp = await fetch(download_url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

  const totalBytes = Number(resp.headers.get('content-length') || 0);
  const archivePath = path.join(paths.cacheRoot, asset_name);
  fs.mkdirSync(paths.cacheRoot, { recursive: true });

  // Stream download with progress
  const writeStream = fs.createWriteStream(archivePath);
  let downloaded = 0;
  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(Buffer.from(value));
    downloaded += value.length;
    if (totalBytes > 0) {
      emit(Math.round((downloaded / totalBytes) * 80), 'downloading');
    }
  }
  await new Promise((res, rej) => writeStream.end(err => err ? rej(err) : res()));

  emit(80, 'extracting');

  const ensureSafeEntryPath = (entryPath) => {
    const normalized = path.normalize(String(entryPath || ''));
    if (!normalized || path.isAbsolute(normalized)) {
      throw new Error(`Unsafe archive entry path: ${entryPath}`);
    }
    if (normalized.split(path.sep).includes('..')) {
      throw new Error(`Unsafe archive entry path: ${entryPath}`);
    }
  };

  if (asset_name.endsWith('.tar.gz') || asset_name.endsWith('.tgz')) {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      strict: false,
      preservePaths: false,
      filter: (entryPath) => {
        ensureSafeEntryPath(entryPath);
        return true;
      }
    });
  } else if (asset_name.endsWith('.zip')) {
    await extract(archivePath, {
      dir: destDir,
      onEntry: (entry) => ensureSafeEntryPath(entry.fileName)
    });
  } else {
    throw new Error(`Unsupported runtime archive format: ${asset_name}`);
  }

  emit(95, 'finalizing');

  // Find the server binary
  let serverPath = '';
  function findBinary(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        findBinary(full);
      } else if (e.name === 'llama-server' || e.name === 'llama-server.exe' || e.name === 'server') {
        serverPath = full;
        if (process.platform !== 'win32') fs.chmodSync(full, 0o755);
      }
    }
  }
  findBinary(destDir);

  // Clean up archive
  fs.unlinkSync(archivePath);

  emit(100, 'complete');

  const runtimeId = path.basename(destDir);
  return {
    success: !!serverPath,
    runtime_id: runtimeId,
    path: serverPath
  };
}

// ── Phase 6: Workspace-RAG ──────────────────────────────────────────────────
// Workspace-scoped document indexing, retrieval, and context assembly for
// injecting workspace knowledge into chat completions.

const TEXT_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
  '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua', '.r', '.m',
  '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.svelte',
  '.vue', '.sh', '.bat', '.ps1', '.sql', '.xml', '.csv', '.ini', '.cfg', '.env',
  '.dockerfile', '.makefile', '.cmake', '.gradle', '.properties', '.conf',
  '.log', '.rst', '.tex', '.org', '.adoc', '.tf', '.hcl', '.proto', '.graphql',
  '.prisma', '.sol', '.zig', '.nim', '.ex', '.exs', '.erl', '.hs', '.ml', '.lisp'
]);

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB per file for RAG ingestion

/**
 * Compute a content-based fingerprint for deduplication.
 */
function computeFileFingerprint(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Index all text files in a workspace folder into the RAG engine,
 * scoped to a specific chat session. Returns a summary of indexed files.
 */
export async function indexWorkspaceRag(workspaceRoot, chatId, options = {}) {
  const chunkSize = Number(options.chunk_size) || 512;
  const maxFiles = Math.min(Number(options.max_files) || 200, 1000);
  const skipPatterns = options.skip_patterns || [];

  const normalizedRoot = path.resolve(workspaceRoot);
  const indexed = [];
  const skipped = [];
  const errors = [];
  let totalChars = 0;
  const pendingIngest = [];

  // Default skip patterns for common non-code directories
  const defaultSkipDirs = new Set([
    'node_modules', '__pycache__', '.git', '.svn', '.hg',
    'dist', 'build', 'target', 'out', 'bin', 'obj',
    '.next', '.nuxt', '.cache', '.turbo', 'coverage',
    'vendor', 'Pods', '.gradle', '.idea', '.vscode',
    '.tox', '.mypy_cache', '.pytest_cache', 'egg-info'
  ]);

  function shouldSkipDir(dirName) {
    if (dirName.startsWith('.')) return true;
    if (defaultSkipDirs.has(dirName)) return true;
    for (const pattern of skipPatterns) {
      if (typeof pattern === 'string' && dirName === pattern) return true;
      if (pattern instanceof RegExp && pattern.test(dirName)) return true;
    }
    return false;
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (indexed.length >= maxFiles) return;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (ext && !TEXT_EXTENSIONS.has(ext)) {
        skipped.push({ path: path.relative(normalizedRoot, fullPath), reason: 'unsupported_extension' });
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        skipped.push({ path: path.relative(normalizedRoot, fullPath), reason: 'stat_failed' });
        continue;
      }

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        skipped.push({ path: path.relative(normalizedRoot, fullPath), reason: 'file_too_large' });
        continue;
      }

      if (stat.size === 0) {
        skipped.push({ path: path.relative(normalizedRoot, fullPath), reason: 'empty_file' });
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const relPath = path.relative(normalizedRoot, fullPath);
        const fingerprint = computeFileFingerprint(fullPath);

        pendingIngest.push({
          source: relPath,
          text: content,
          file_type: ext.slice(1) || 'text',
          fingerprint,
          char_count: content.length,
          name: entry.name
        });
      } catch (err) {
        errors.push({
          path: path.relative(normalizedRoot, fullPath),
          error: err.message || String(err)
        });
      }
    }
  }

  walk(normalizedRoot);

  // Batch ingest all collected files
  for (const item of pendingIngest) {
    try {
      const doc = await ingestText({
        source: item.source,
        text: item.text,
        chat_id: chatId,
        file_type: item.file_type
      });
      indexed.push({
        path: item.source,
        name: item.name,
        doc_id: doc.id,
        char_count: item.char_count,
        chunk_count: doc.chunk_count,
        fingerprint: item.fingerprint
      });
      totalChars += item.char_count;
    } catch (err) {
      errors.push({
        path: item.source,
        error: err.message || String(err)
      });
    }
  }

  return {
    workspace_root: normalizedRoot,
    chat_id: chatId,
    indexed_count: indexed.length,
    skipped_count: skipped.length,
    error_count: errors.length,
    total_chars: totalChars,
    indexed,
    skipped,
    errors
  };
}

/**
 * Query workspace documents that were previously indexed via indexWorkspaceRag.
 * Wraps the RAG queryDocuments with workspace-aware context formatting.
 */
export async function queryWorkspaceRag(workspaceRoot, chatId, query, topK = 8) {
  const result = await queryRagDocuments({
    query,
    chat_id: chatId,
    top_k: Math.max(1, Math.min(topK, 20))
  });

  const rootName = path.basename(workspaceRoot);

  // Format context with workspace source annotations
  const contextParts = result.results.map((entry) => {
    const source = entry.document?.source || 'unknown';
    const score = typeof entry.score === 'number' ? ` (relevance: ${entry.score.toFixed(2)})` : '';
    return `[${rootName}/${source}]${score}\n${entry.chunk.text}`;
  });

  return {
    results: result.results,
    context: contextParts.join('\n\n---\n\n'),
    context_available: result.results.length > 0,
    result_count: result.results.length
  };
}

/**
 * Build a RAG-augmented system message prefix that injects workspace context
 * relevant to the user's query. Returns the context string and metadata.
 */
export async function buildWorkspaceContext(workspaceRoot, chatId, query, options = {}) {
  const maxContextChars = Math.min(Number(options.max_context_chars) || 4000, 16000);
  const topK = Number(options.top_k) || 6;

  if (!query || !query.trim()) {
    return {
      context: '',
      sources: [],
      char_count: 0,
      truncated: false
    };
  }

  const ragResult = await queryWorkspaceRag(workspaceRoot, chatId, query, topK);

  if (!ragResult.context_available) {
    return {
      context: '',
      sources: [],
      char_count: 0,
      truncated: false
    };
  }

  let context = ragResult.context;
  let truncated = false;

  if (context.length > maxContextChars) {
    context = context.slice(0, maxContextChars);
    truncated = true;
  }

  const sources = ragResult.results.map((r) => ({
    path: r.document?.source || 'unknown',
    chunk_id: r.chunk?.id || '',
    score: r.score || 0
  }));

  return {
    context,
    sources,
    char_count: context.length,
    truncated
  };
}

/**
 * Get a summary of all RAG-indexed documents for a workspace/chat.
 * Returns file paths, chunk counts, and total characters.
 */
export async function getWorkspaceRagSummary(chatId) {
  const docs = await listRagDocuments(chatId);

  return {
    chat_id: chatId,
    document_count: docs.length,
    total_chunks: docs.reduce((sum, d) => sum + (d.chunk_count || 0), 0),
    total_chars: docs.reduce((sum, d) => sum + (d.char_count || 0), 0),
    documents: docs.map((d) => ({
      id: d.id,
      source: d.source,
      file_type: d.file_type,
      chunk_count: d.chunk_count,
      char_count: d.char_count
    }))
  };
}

/**
 * Remove a specific document from the workspace RAG index.
 */
export async function removeWorkspaceRagDocument(docId, chatId) {
  return removeRagDocument(docId, chatId);
}

/**
 * Clear all RAG documents for a workspace/chat session.
 */
export async function clearWorkspaceRag(chatId) {
  return clearRagDocuments(chatId);
}

/**
 * Format a RAG context block for injection into a chat completion system prompt.
 * Returns a string that can be prepended to the system message.
 */
export function formatRagContextForPrompt(context, sources = []) {
  if (!context || !context.trim()) return '';

  const header = '--- Workspace Context ---';
  const sourceList = sources.length
    ? `\nSources: ${sources.map((s) => s.path).filter(Boolean).join(', ')}`
    : '';

  return `\n${header}\nThe following context was retrieved from the workspace files:\n\n${context}\n${sourceList}\n--- End Workspace Context ---\n`;
}

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsonl',
  'jsx', 'log', 'md', 'mjs', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'toml', 'ts', 'tsx',
  'txt', 'xml', 'yaml', 'yml'
]);

const MAX_WORKSPACE_FILES = 50;
const MAX_FILE_SIZE = 512 * 1024;

export async function ingestWorkspaceFiles(folderPath, chatId, options = {}) {
  const { files: indexedFiles } = await indexWorkspaceFolder(folderPath, chatId);
  if (!indexedFiles || !indexedFiles.length) {
    return { ingested_count: 0, skipped_count: 0, total_files: 0 };
  }

  const maxFiles = options?.maxFiles || MAX_WORKSPACE_FILES;
  const textFiles = indexedFiles.filter((f) =>
    f.status === 'ready' && f.size <= MAX_FILE_SIZE
  );

  let ingested_count = 0;
  let skipped_count = 0;

  for (const file of textFiles.slice(0, maxFiles)) {
    try {
      const filePath = path.join(folderPath, file.path);
      const content = fs.readFileSync(filePath, 'utf8');
      const ext = path.extname(file.path).toLowerCase().replace('.', '') || 'text';
      if (!WORKSPACE_TEXT_EXTENSIONS.has(ext) && ext !== 'text') {
        skipped_count++;
        continue;
      }
      await ingestText({
        source: file.path,
        text: content,
        chat_id: chatId,
        file_type: ext
      });
      ingested_count++;
    } catch {
      skipped_count++;
    }
  }

  return {
    ingested_count,
    skipped_count,
    total_files: indexedFiles.length
  };
}
