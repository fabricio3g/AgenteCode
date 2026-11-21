import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { shell, dialog } from 'electron';
import { getAppPaths } from './paths.ts';

const ALLOWED_WORKSPACE_COMMANDS = new Set([
  'node', 'npm', 'npx', 'python', 'python3', 'python2', 'pip', 'pip3',
  'ruby', 'gem', 'cargo', 'rustc', 'go', 'java', 'javac', 'make', 'cmake',
  'bash', 'sh', 'dash', 'zsh', 'perl', 'php', 'lua', 'R', 'rscript',
  'git', 'curl', 'wget', 'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'cat', 'head', 'tail', 'grep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc',
  'jq', 'pandoc', 'docker', 'docker-compose', 'podman',
  'chmod', 'chown', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'ls', 'pwd', 'cd', 'echo',
  'pandoc', 'latex', 'pdflatex', 'xelatex', 'lualatex',
  'dir', 'type', 'copy', 'move', 'ren', 'findstr', 'where', 'more', 'fc'
]);

function isWorkspaceCommandAllowed(cmd) {
  const base = path.basename(cmd).toLowerCase().replace(/\.exe$/i, '');
  if (ALLOWED_WORKSPACE_COMMANDS.has(base)) return true;
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  return ALLOWED_WORKSPACE_COMMANDS.has(cmd.toLowerCase().replace(/\.exe$/i, ''));
}

function workspaceEnv() {
  const safe: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TZ: process.env.TZ || 'UTC',
    HOME: process.env.HOME || process.env.USERPROFILE || '',
    USER: process.env.USER || 'user',
  };
  Object.keys(safe).forEach(k => { if (safe[k] === undefined) delete safe[k]; });
  return safe;
}

const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024; // 1 MB per stream

function normalizeComparePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const normCandidate = normalizeComparePath(candidate);
  const normRoot = normalizeComparePath(root);
  if (normCandidate === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normCandidate.startsWith(prefix);
}

function lstatExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function realpathOfNearestExistingAncestor(targetPath: string): string {
  let cursor = path.resolve(targetPath);
  while (!lstatExists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return fs.realpathSync(cursor);
}

/**
 * Containment check for workspace file ops.
 *
 * Resolves both root and target (walking up to the nearest existing ancestor
 * when the target does not yet exist) so `..` segments, absolute relativePaths,
 * prefix collisions (`root-evil` vs `root`), and symlink escapes like
 * `symlink_out/new_subdir/file.txt` cannot escape.
 */
function resolveWorkspacePath(workspaceRoot, relativePath) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error('Workspace root is required');
  }
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Relative path is required');
  }
  const root = path.resolve(workspaceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Workspace root not found');
  }
  const fullPath = path.resolve(root, relativePath);
  if (!isPathWithinRoot(fullPath, root)) {
    throw new Error('Path traversal not allowed');
  }
  try {
    const realRoot = fs.realpathSync(root);
    const realAncestor = realpathOfNearestExistingAncestor(fullPath);
    if (!isPathWithinRoot(realAncestor, realRoot)) {
      throw new Error('Path traversal not allowed');
    }
  } catch {
    throw new Error('Path traversal not allowed');
  }
  return fullPath;
}

export async function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

/**
 * Single-IPC projector lookup next to a GGUF model (or inside a directory),
 * replacing the renderer's N×36 `path_exists` round-trip loop.
 */
export async function listMmprojCandidates(modelPath: string): Promise<string[]> {
  if (typeof modelPath !== 'string' || !modelPath.trim()) return [];
  let dir = path.dirname(modelPath);
  try {
    if (fs.existsSync(modelPath) && fs.statSync(modelPath).isDirectory()) {
      dir = modelPath;
    }
  } catch {
    // Keep dirname fallback when stat fails.
  }
  const orderedNames = [
    'mmproj-BF16.gguf',
    'mmproj-F16.gguf',
    'mmproj-F32.gguf',
    'mmproj.gguf'
  ];
  const modelBase = path.basename(modelPath).replace(/\.gguf$/i, '');
  if (modelBase) {
    orderedNames.push(
      `mmproj-${modelBase}.gguf`,
      `${modelBase}-mmproj.gguf`,
      `${modelBase}.mmproj.gguf`,
      `${modelBase}.projector.gguf`,
      `projector-${modelBase}.gguf`
    );
  }
  const found: string[] = [];
  for (const name of orderedNames) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate) && !found.includes(candidate)) {
        found.push(candidate);
      }
    } catch {
      // Ignore unreadable entries.
    }
  }
  return found;
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

export async function pickMmprojFile() {
  const result = await dialog.showOpenDialog({
    title: 'Select a Vision Projector (mmproj) GGUF',
    properties: ['openFile'],
    filters: [
      { name: 'GGUF Models', extensions: ['gguf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

export async function pickWhisperRuntimeFile() {
  const result = await dialog.showOpenDialog({
    title: 'Select whisper.cpp Runtime',
    properties: ['openFile'],
    filters: [
      { name: 'whisper.cpp Runtime', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
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
  } catch (err: unknown) {
    return {
      root_path: folderPath, root_name: rootName,
      file_count: 0, indexed_count: 0, skipped_count: 0, files: [],
      error: err instanceof Error ? err.message : String(err)
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
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

/** Writes a generated binary (a `data:…;base64,` URL) into the workspace. */
export async function writeWorkspaceBinary(workspaceRoot, relativePath, dataUrl) {
  const match = /^data:[^;,]*;base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) throw new Error('Expected a base64 data URL.');
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(match[1], 'base64'));
  return fullPath;
}

export async function readWorkspaceFile(workspaceRoot, relativePath) {
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  return fs.readFileSync(fullPath, 'utf8');
}

/** Raw bytes of a workspace file as a base64 data URL (documents, images, audio). */
export async function readWorkspaceBinary(workspaceRoot, relativePath) {
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  const stat = fs.statSync(fullPath);
  if (stat.size > 50 * 1024 * 1024) throw new Error('File is larger than 50 MB.');
  return `data:application/octet-stream;base64,${fs.readFileSync(fullPath).toString('base64')}`;
}

export async function createWorkspaceDocument(workspaceRoot, relativePath, docType, content) {
  return writeWorkspaceFile(workspaceRoot, relativePath, content);
}

export async function renameWorkspaceFile(workspaceRoot, oldPath, newPath) {
  const oldFull = resolveWorkspacePath(workspaceRoot, oldPath);
  const newFull = resolveWorkspacePath(workspaceRoot, newPath);
  fs.mkdirSync(path.dirname(newFull), { recursive: true });
  fs.renameSync(oldFull, newFull);
}

export async function deleteWorkspaceFile(workspaceRoot, relativePath) {
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  if (fullPath === path.resolve(workspaceRoot)) throw new Error('Refusing to delete workspace root');
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
}

function isInsideAppOwnedDir(absolutePath: string): boolean {
  const candidates: string[] = [path.join(os.tmpdir(), 'chatealm')];
  try {
    candidates.push(getAppPaths().appData);
  } catch {
    // Electron app paths may be unavailable in pure unit tests
  }
  const coreAttachmentsDir = path.join(
    process.env.AGENTE_CONFIG_DIR || path.join(os.homedir(), '.agente'),
    'attachments'
  );
  candidates.push(coreAttachmentsDir);

  const resolvedTarget = path.resolve(absolutePath);
  for (const dir of candidates) {
    if (!dir) continue;
    const resolvedDir = path.resolve(dir);
    if (!isPathWithinRoot(resolvedTarget, resolvedDir)) continue;
    try {
      if (!fs.existsSync(resolvedDir)) continue;
      const realDir = fs.realpathSync(resolvedDir);
      const realTarget = realpathOfNearestExistingAncestor(resolvedTarget);
      if (isPathWithinRoot(realTarget, realDir)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function openWorkspaceFile(absolutePath, workspaceRoot) {
  if (typeof absolutePath !== 'string' || !absolutePath.trim()) {
    throw new Error('File path is required');
  }
  // Pin opens inside workspace when root is provided; otherwise allow only app-owned directories.
  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(absolutePath);
    const rel = path.relative(root, target) || '.';
    const fullPath = resolveWorkspacePath(root, rel);
    shell.openPath(fullPath);
    return;
  }
  if (!isInsideAppOwnedDir(absolutePath)) {
    throw new Error('Workspace root is required to open files outside app directories');
  }
  shell.openPath(path.resolve(absolutePath));
}

export async function createWorkspaceFolder(workspaceRoot, relativePath) {
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  fs.mkdirSync(fullPath, { recursive: true });
}

export async function workspaceExec({ workspace_root, command, args: execArgs, cwd, timeout_ms }) {
  // Pin exec cwd inside a valid workspace root; absolute and symlink escapes refused.
  if (typeof workspace_root !== 'string' || !workspace_root.trim()) {
    return {
      cwd: String(cwd || ''),
      stdout: '',
      stderr: 'Workspace root is required',
      exit_code: -1,
      timed_out: false,
      error: 'Workspace root is required'
    };
  }

  let workDir: string;
  try {
    const resolvedRoot = resolveWorkspacePath(workspace_root, '.');
    if (cwd) {
      const targetRel = path.isAbsolute(String(cwd))
        ? (path.relative(resolvedRoot, path.resolve(String(cwd))) || '.')
        : String(cwd);
      workDir = resolveWorkspacePath(resolvedRoot, targetRel);
    } else {
      workDir = resolvedRoot;
    }
    if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
      throw new Error('Working directory not found');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Working directory escapes workspace root';
    return {
      cwd: String(cwd || workspace_root),
      stdout: '',
      stderr: msg,
      exit_code: -1,
      timed_out: false,
      error: msg
    };
  }

  if (typeof command !== 'string' || !command.trim() || !isWorkspaceCommandAllowed(command)) {
    return {
      cwd: workDir,
      stdout: '',
      stderr: `Command not allowed: ${String(command || '')}. Allowed commands: ${[...ALLOWED_WORKSPACE_COMMANDS].join(', ')}`,
      exit_code: -1,
      timed_out: false,
      error: 'Command not in allowlist'
    };
  }

  const safeArgs = Array.isArray(execArgs) ? execArgs.map((arg) => String(arg)) : [];
  const timeoutMs = timeout_ms || 30000;
  const env = workspaceEnv();

  return new Promise((resolve) => {
    const proc = spawn(command, safeArgs, {
      cwd: workDir,
      shell: false,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_EXEC_OUTPUT_BYTES - stdoutBytes;
      if (buf.byteLength <= remaining) {
        stdout += buf.toString('utf8');
        stdoutBytes += buf.byteLength;
      } else {
        if (remaining > 0) stdout += buf.subarray(0, remaining).toString('utf8');
        stdoutBytes = MAX_EXEC_OUTPUT_BYTES;
        stdoutTruncated = true;
        stdout += '\n... (output truncated)';
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderrTruncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_EXEC_OUTPUT_BYTES - stderrBytes;
      if (buf.byteLength <= remaining) {
        stderr += buf.toString('utf8');
        stderrBytes += buf.byteLength;
      } else {
        if (remaining > 0) stderr += buf.subarray(0, remaining).toString('utf8');
        stderrBytes = MAX_EXEC_OUTPUT_BYTES;
        stderrTruncated = true;
        stderr += '\n... (output truncated)';
      }
    });

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

const TEMP_FILE_NAME_LIMIT = 128;

function sanitizeTempFileName(name) {
  const base = path.basename(String(name || 'upload.bin'));
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, TEMP_FILE_NAME_LIMIT);
  return clean || 'upload.bin';
}

export async function writeTempFile(name, data) {
  const tmpDir = path.join(os.tmpdir(), 'chatealm');
  fs.mkdirSync(tmpDir, { recursive: true });
  // Basename-only: chat-provided filenames never steer directories.
  const filePath = path.join(tmpDir, sanitizeTempFileName(name));
  const buffer = Buffer.from(data);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export async function resetMediaPermissions() {
  return { removed: [], failed: [] };
}
