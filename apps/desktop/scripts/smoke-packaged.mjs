import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || `release/${process.platform === 'win32' ? 'win' : 'linux'}-unpacked`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'Agente packaged ñ '));
const copied = path.join(temporary, 'Application ñ with spaces');
const diagnostics = path.resolve('release/smoke-diagnostics');
fs.mkdirSync(diagnostics, { recursive: true });
fs.cpSync(root, copied, { recursive: true });
// Ubuntu runners restrict unprivileged user namespaces. Configure Chromium's
// supported SUID helper in the temporary copy instead of disabling sandboxing.
if (process.platform === 'linux' && process.env.AGENTE_SMOKE_SETUID === '1') {
  const sandbox = path.join(copied, 'chrome-sandbox');
  execFileSync('sudo', ['chown', 'root:root', sandbox], { stdio: 'inherit' });
  execFileSync('sudo', ['chmod', '4755', sandbox], { stdio: 'inherit' });
}
const profiles = [];
let executable = path.join(copied, process.platform === 'win32' ? 'Agente.exe' : 'agente-desktop');
async function launch(testCase) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'Agente smoke ñ '));
    profiles.push(profile);
    const child = spawn(executable, ['--smoke-test'], { env: { ...process.env, AGENTE_BIN: '', AGENTE_SMOKE_PROFILE: profile, AGENTE_SMOKE_CASE: testCase }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (data) => { output += data; process.stdout.write(data); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Packaged ${testCase || 'startup'} timed out`)); }, 45_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      fs.writeFileSync(path.join(diagnostics, `${testCase || 'ready'}.log`), `${output}\n${error.stack || error}`);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      const marker = testCase ? 'SMOKE_FAILURE_SCREEN ' : 'SMOKE_READY ';
      const line = output.split(/\r?\n/).find((value) => value.startsWith(marker));
      fs.writeFileSync(path.join(diagnostics, `${testCase || 'ready'}.log`), output);
      const logs = path.join(profile, 'browser/logs');
      if (fs.existsSync(logs)) fs.cpSync(logs, path.join(diagnostics, testCase || 'ready'), { recursive: true });
      if (!line || code !== (testCase ? 1 : 0)) return reject(new Error(`Packaged ${testCase || 'startup'} failed (exit ${code})`));
      JSON.parse(line.slice(marker.length));
      resolve();
    });
  });
}
try {
  fs.writeFileSync(path.join(diagnostics, 'launch.json'), JSON.stringify({ root, copied, executable, sourceFiles: fs.readdirSync(root), copiedFiles: fs.readdirSync(copied), executableExists: fs.existsSync(executable) }, null, 2));
  // Expand Windows' DOS short paths before CreateProcess and DLL resolution.
  if (process.platform === 'win32') executable = fs.realpathSync.native(executable);
  for (const testCase of ['', 'missing-assets', 'bootstrap']) await launch(testCase);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true });
}
