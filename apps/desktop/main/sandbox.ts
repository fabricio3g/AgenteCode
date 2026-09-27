import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SANDBOX_ROOT = path.join(os.tmpdir(), 'chatealm-sandbox');

const ALLOWED_COMMANDS = new Set([
  'node', 'nodejs', 'npm', 'npx', 'python', 'python3', 'python2', 'pip', 'pip3',
  'ruby', 'gem', 'cargo', 'rustc', 'go', 'java', 'javac', 'gcc', 'g++',
  'make', 'cmake', 'bash', 'sh', 'dash', 'zsh',
  'perl', 'php', 'lua', 'R', 'rscript',
  'git', 'curl', 'wget', 'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'cat', 'head', 'tail', 'grep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc',
  'jq', 'xmllint', 'iconv', 'base64', 'xxd', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum',
  'pandoc', 'latex', 'pdflatex', 'xelatex', 'lualatex',
  'cp', 'mv', 'mkdir', 'rmdir', 'ls', 'pwd', 'echo'
]);

// Minimal safe environment — only what's needed for compilation/execution
function sandboxEnv() {
  const safe: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TZ: process.env.TZ || 'UTC',
    TMPDIR: SANDBOX_ROOT,
    TMP: SANDBOX_ROOT,
    TEMP: SANDBOX_ROOT,
    HOME: SANDBOX_ROOT,
    USER: 'sandbox',
    SANDBOX_ROOT,
  };
  Object.keys(safe).forEach(k => { if (safe[k] === undefined) delete safe[k]; });
  return safe;
}

function isCommandAllowed(cmd: string): boolean {
  const base = path.basename(cmd).toLowerCase().replace(/-/g, '');
  if (ALLOWED_COMMANDS.has(base)) return true;
  return ALLOWED_COMMANDS.has(cmd.toLowerCase());
}

function safePath(projectDir: string, filePath: string): string {
  const resolved = path.resolve(projectDir, path.normalize(filePath));
  if (!resolved.startsWith(path.resolve(projectDir) + path.sep) && resolved !== path.resolve(projectDir)) {
    throw new Error(`Path traversal blocked: ${filePath}`);
  }
  return resolved;
}

export function getSandboxDir(projectName?: string): string {
  return path.join(SANDBOX_ROOT, projectName || `sandbox-${Date.now()}`);
}

export async function sandboxExec({
  projectName,
  files,
  command,
  args: execArgs,
  shell: useShell,
  timeoutMs,
  preserve,
  commandStr
}: {
  projectName?: string;
  files?: Record<string, string>;
  command: string;
  args?: string[];
  shell?: boolean;
  timeoutMs?: number;
  preserve?: boolean;
  commandStr?: string;
}) {
  const projectDir = path.join(SANDBOX_ROOT, projectName || `sandbox-${Date.now()}`);
  const shellCommand = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const shellArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', commandStr || '']
    : ['-c', commandStr || ''];

  if (!isCommandAllowed(command)) {
    return {
      cwd: projectDir,
      stdout: '',
      stderr: `Command not allowed: ${command}. Allowed commands: ${[...ALLOWED_COMMANDS].join(', ')}`,
      exit_code: -1,
      timed_out: false,
      files: {},
      error: 'Command not in allowlist'
    };
  }

  if (!preserve) {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdirSync(projectDir, { recursive: true });

  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = safePath(projectDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }
  }

  const timeout = timeoutMs || 30000;
  const env = sandboxEnv();

  return new Promise<{
    cwd: string;
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    files: Record<string, string>;
    error?: string;
  }>((resolve) => {
    let proc;

    if (commandStr) {
      proc = spawn(shellCommand, shellArgs, {
        cwd: projectDir,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    } else if (useShell) {
      proc = spawn(command, execArgs || [], {
        cwd: projectDir,
        shell: true,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    } else {
      proc = spawn(command, execArgs || [], {
        cwd: projectDir,
        shell: false,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeout);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);

      const outputFiles: Record<string, string> = {};
      try {
        function readDir(dir: string, rel = '') {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              readDir(full, relPath);
            } else if (e.isFile()) {
              try {
                outputFiles[relPath] = fs.readFileSync(full, 'utf8');
              } catch { /* binary, skip */ }
            }
          }
        }
        readDir(projectDir);
      } catch { /* ignore */ }

      resolve({
        cwd: projectDir,
        stdout,
        stderr,
        exit_code: code ?? -1,
        timed_out: timedOut,
        files: outputFiles
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        cwd: projectDir,
        stdout,
        stderr: stderr + '\n' + err.message,
        exit_code: -1,
        timed_out: false,
        files: {}
      });
    });
  });
}

export async function sandboxCodeExec({
  projectName,
  language,
  code,
  timeoutMs
}: {
  projectName?: string;
  language: 'javascript' | 'python';
  code: string;
  timeoutMs?: number;
}) {
  const effectiveProjectName = projectName || `code-${Date.now()}`;
  const projectDir = getSandboxDir(effectiveProjectName);
  fs.mkdirSync(projectDir, { recursive: true });

  const ext = language === 'javascript' ? 'js' : 'py';
  const cmd = language === 'javascript' ? 'node' : (process.platform === 'win32' ? 'python' : 'python3');
  const scriptName = `__sandbox__.${ext}`;
  const scriptPath = path.join(projectDir, scriptName);

  fs.writeFileSync(scriptPath, code, 'utf8');

  const result = await sandboxExec({
    projectName: effectiveProjectName,
    command: cmd,
    args: [scriptName],
    shell: false,
    timeoutMs: timeoutMs || 30000,
    preserve: true
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exit_code,
    timedOut: result.timed_out,
    files: result.files
  };
}
