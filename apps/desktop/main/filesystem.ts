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

/**
 * Containment check for workspace file ops.
 *
 * Resolves both root and target so `..` segments, absolute
 * relativePaths and prefix collisions (`root-evil` vs `root`)
 * cannot escape. Rejects missing roots and symlink escapes.
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
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
  try {
    const realRoot = fs.realpathSync(root);
    const parent = path.dirname(fullPath);
    if (fs.existsSync(fullPath)) {
      const realTarget = fs.realpathSync(fullPath);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new Error('Path traversal not allowed');
      }
    } else if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
        throw new Error('Path traversal not allowed');
      }
    }
  } catch {
    throw new Error('Path traversal not allowed');
  }
  return fullPath;
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

export async function openWorkspaceFile(absolutePath, workspaceRoot) {
  // Pin opens inside workspace when root known; standalone absolute
  // opens stay for app-owned paths (models folder uses openModelsFolder).
  if (workspaceRoot) {
    const fullPath = resolveWorkspacePath(workspaceRoot, path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath)));
    shell.openPath(fullPath);
    return;
  }
  shell.openPath(absolutePath);
}

export async function createWorkspaceFolder(workspaceRoot, relativePath) {
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath);
  fs.mkdirSync(fullPath, { recursive: true });
}

export async function workspaceExec({ workspace_root, command, args: execArgs, cwd, shell: useShell, timeout_ms }) {
  // Pin exec cwd inside workspace root; absolute escapes refused.
  let workDir = workspace_root;
  if (cwd) {
    const root = path.resolve(workspace_root || '');
    const resolved = path.resolve(root, cwd);
    if (!workspace_root || (resolved !== root && !resolved.startsWith(root + path.sep))) {
      return {
        cwd: String(cwd),
        stdout: '',
        stderr: 'Working directory escapes workspace root',
        exit_code: -1,
        timed_out: false,
        error: 'Working directory escapes workspace root'
      };
    }
    workDir = resolved;
  }

  if (useShell !== true && !isWorkspaceCommandAllowed(command)) {
    return {
      cwd: workDir,
      stdout: '',
      stderr: `Command not allowed: ${command}. Allowed commands: ${[...ALLOWED_WORKSPACE_COMMANDS].join(', ')}`,
      exit_code: -1,
      timed_out: false,
      error: 'Command not in allowlist'
    };
  }

  const timeoutMs = timeout_ms || 30000;
  const env = workspaceEnv();

  return new Promise((resolve) => {
    let proc;
    proc = spawn(command, execArgs || [], {
      cwd: workDir,
      shell: useShell === true,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
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
