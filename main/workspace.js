import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { shell, dialog } from 'electron';
import { getAppPaths } from './index.js';

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
  const tmpDir = path.join(os.tmpdir(), 'talamolm');
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

  // Extract based on file type
  const { execSync } = await import('node:child_process');
  if (asset_name.endsWith('.tar.gz') || asset_name.endsWith('.tgz')) {
    execSync(`tar xzf "${archivePath}" -C "${destDir}"`, { stdio: 'ignore' });
  } else if (asset_name.endsWith('.zip')) {
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'ignore' });
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
