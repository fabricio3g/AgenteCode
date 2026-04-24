import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SANDBOX_ROOT = path.join(os.tmpdir(), 'chatealm-sandbox');

const ALLOWED_COMMANDS = new Set([
  'node', 'nodejs', 'npm', 'npx', 'python', 'python3', 'python2', 'pip', 'pip3',
  'ruby', 'gem', 'cargo', 'rustc', 'go', 'java', 'javac', 'c', 'cc', 'cpp',
  'gcc', 'g++', 'make', 'cmake', 'bash', 'sh', 'dash', 'zsh', 'powershell',
  'pwsh', 'perl', 'php', 'lua', 'R', 'rscript',
  'docker', 'docker-compose', 'podman',
  'git', 'curl', 'wget', 'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'cat', 'head', 'tail', 'grep', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc',
  'jq', 'xmllint', 'iconv', 'base64', 'xxd', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum',
  'pandoc', 'latex', 'pdflatex', 'xelatex', 'lualatex',
  'lsblk', 'cp', 'mv', 'mkdir', 'rmdir'
]);

function isCommandAllowed(cmd) {
  const base = path.basename(cmd).toLowerCase().replace(/-/g, '');
  if (ALLOWED_COMMANDS.has(base)) return true;
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  return ALLOWED_COMMANDS.has(cmd.toLowerCase());
}

export async function sandboxExec({ projectName, files, command, args: execArgs, shell: useShell, timeoutMs, preserve }) {
  const projectDir = path.join(SANDBOX_ROOT, projectName || `sandbox-${Date.now()}`);

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

  // Write files
  for (const [filePath, content] of Object.entries(files || {})) {
    const fullPath = path.join(projectDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  const timeout = timeoutMs || 30000;
  const useLoginShell = useShell !== false;

  return new Promise((resolve) => {
    let proc;
    if (useLoginShell) {
      // Use login shell for proper PATH (finds npm, node, python3, etc.)
      const joined = execArgs?.length
        ? `${command} ${execArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`
        : command;
      proc = spawn('sh', ['-lc', joined], {
        cwd: projectDir,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: os.homedir(), TMPDIR: os.tmpdir() }
      });
    } else {
      proc = spawn(command, execArgs || [], {
        cwd: projectDir,
        shell: false,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: os.homedir(), TMPDIR: os.tmpdir() }
      });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Read back files
      const outputFiles = {};
      function readDir(dir, rel = '') {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              readDir(full, relPath);
            } else if (e.isFile()) {
              try {
                outputFiles[relPath] = fs.readFileSync(full, 'utf8');
              } catch {
                // binary file, skip
              }
            }
          }
        } catch {
          // ignore
        }
      }
      readDir(projectDir);

      resolve({
        cwd: projectDir,
        stdout,
        stderr,
        exit_code: code,
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
