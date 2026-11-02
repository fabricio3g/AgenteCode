import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { getAppPaths } from '../paths.ts';
import { sceneSchema, type BlenderState, type DesignScene } from '../../shared/design-3d.ts';
import { workspaceRoot, ensureWorkspace } from './workspace.ts';
import { runDesignFileTool } from './tools.ts';
import { BLENDER_SCRIPT } from './blender-script.ts';
import { checkBlender, findBlender, installBlender, isInstallingBlender, rememberBlender } from './blender-engine.ts';

type Job = { id: string; owner?: string; process?: ChildProcess; log: string; stopped: boolean; phase: string };
const jobs = new Map<string, Job>();
const failures = new Map<string, string>();
const roots = (chatId: unknown) => {
  const appData = getAppPaths().appData;
  return { workspace: ensureWorkspace(workspaceRoot(path.join(appData, 'designs'), chatId)), output: ensureWorkspace(workspaceRoot(path.join(appData, 'design-3d'), chatId)) };
};
function stop(job: Job) {
  job.stopped = true;
  if (!job.process?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(job.process.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else job.process.kill('SIGKILL');
}
app.on('before-quit', () => { for (const job of jobs.values()) stop(job); });

function currentOutput(root: string): string | undefined {
  try {
    const id = fs.readFileSync(path.join(root, 'current'), 'utf8').trim();
    if (/^[a-f0-9-]{36}$/.test(id)) return path.join(root, id);
  } catch { /* No completed build. */ }
}
function readLog(directory?: string): string | undefined {
  if (!directory) return;
  try { return fs.readFileSync(path.join(directory, 'output.log'), 'utf8').slice(-32768); } catch { return; }
}
export function blenderState(chatId: string): BlenderState {
  const { workspace, output } = roots(chatId);
  const job = jobs.get(chatId);
  const directory = currentOutput(output);
  let scene: DesignScene | undefined;
  try { scene = sceneSchema.parse(JSON.parse(fs.readFileSync(path.join(workspace, 'scene.json'), 'utf8'))); } catch { /* First scene. */ }
  const executable = findBlender();
  return {
    available: !!executable, executable, installing: isInstallingBlender(), busy: !!job, jobId: job?.id,
    phase: job?.phase, log: job?.log ?? readLog(directory), error: failures.get(chatId), scene,
    model: !!directory && fs.existsSync(path.join(directory, 'model.glb')),
    render: !!directory && fs.existsSync(path.join(directory, 'render.png')),
    updatedAt: directory ? fs.statSync(directory).mtimeMs : undefined
  };
}
function notify(event: IpcMainInvokeEvent, chatId: string) {
  if (!event.sender.isDestroyed()) event.sender.send('design_3d_changed', { chatId });
}

async function build(event: IpcMainInvokeEvent, chatId: string, input: unknown, render: boolean, owner?: string): Promise<BlenderState> {
  if (jobs.has(chatId)) throw new Error('This design already has a Blender job running.');
  if (jobs.size >= 2) throw new Error('Two Blender jobs are already running. Retry when one finishes.');
  const executable = findBlender();
  if (!executable) throw new Error('Install or choose Blender in Design → 3D first.');
  const scene = sceneSchema.parse(input);
  const encoded = JSON.stringify(scene, null, 2);
  if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('Scene exceeds 512 KB.');
  const { workspace, output } = roots(chatId);
  const saved = runDesignFileTool(workspace, 'design_write', { path: 'scene.json', content: encoded });
  if (!saved.ok) throw new Error(saved.content);
  const job: Job = { id: randomUUID(), owner, log: '', stopped: false, phase: render ? 'Building and rendering' : 'Building model' };
  const directory = path.join(output, job.id);
  fs.mkdirSync(directory);
  const script = path.join(directory, 'build.py');
  const source = path.join(directory, 'scene.json');
  fs.writeFileSync(script, BLENDER_SCRIPT);
  fs.writeFileSync(source, encoded);
  jobs.set(chatId, job); failures.delete(chatId);
  notify(event, chatId);
  let lastUpdate = 0;
  const append = (chunk: Buffer | string) => {
    job.log = (job.log + String(chunk)).slice(-32768);
    if (Date.now() - lastUpdate > 300) { lastUpdate = Date.now(); notify(event, chatId); }
  };
  try {
    const execute = () => new Promise<void>((resolve, reject) => {
      const process = spawn(executable, [
        '--background', '--factory-startup', '--disable-autoexec', '--threads', String(Math.min(8, Math.max(1, Math.floor(os.cpus().length / 2)))),
        '--python-exit-code', '1', '--python', script, '--', source, directory, render ? '1' : '0'
      ], { cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      job.process = process;
      const timer = setTimeout(() => { stop(job); }, 10 * 60_000);
      process.stdout?.on('data', append); process.stderr?.on('data', append);
      process.once('error', error => { clearTimeout(timer); reject(error); });
      process.once('close', code => {
        clearTimeout(timer);
        if (job.stopped) reject(new Error('Blender job stopped or exceeded its 10-minute limit.'));
        else if (code !== 0) reject(new Error(`Blender exited (${code}). ${job.log.slice(-2000)}`));
        else resolve();
      });
    });
    try { await execute(); }
    catch (error) {
      if (job.stopped || !render || scene.render.engine !== 'eevee') throw error;
      // A background host may have no usable graphics context; Cycles CPU works without one.
      append('\nRetrying with Cycles CPU.\n');
      scene.render.engine = 'cycles';
      fs.writeFileSync(source, JSON.stringify(scene));
      await execute();
    }
  } catch (error) {
    failures.set(chatId, String(error));
  } finally {
    try {
      fs.writeFileSync(path.join(directory, 'output.log'), job.log);
      if (fs.existsSync(path.join(directory, 'model.glb'))) {
        const next = path.join(output, 'current.next');
        fs.writeFileSync(next, job.id); fs.renameSync(next, path.join(output, 'current'));
      }
    } catch (error) { failures.set(chatId, `Saving Blender output: ${String(error)}`); }
    finally { jobs.delete(chatId); notify(event, chatId); }
    if (!event.sender.isDestroyed()) event.sender.send('design_changed', { chatId, paths: ['scene.json'] });
    // Keep three build outputs. Only UUID children created by this controller can be pruned.
    try {
    const runs = fs.readdirSync(output).filter(name => /^[a-f0-9-]{36}$/.test(name))
      .map(name => path.join(output, name)).filter(file => !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isDirectory())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const current = currentOutput(output);
    for (const obsolete of runs.slice(3)) {
      const resolved = path.resolve(obsolete);
      if (resolved !== current && path.dirname(resolved) === path.resolve(output)) fs.rmSync(resolved, { recursive: true, force: true });
    }
    } catch (error) { console.warn('[design-3d] Could not prune old outputs:', String(error)); }
  }
  return blenderState(chatId);
}

/** Renderer can name an asset, never an absolute path. Binary outputs stay outside HTML snapshots. */
export async function runBlenderRequest(event: IpcMainInvokeEvent, request: { chatId: string; action: string; scene?: unknown; render?: boolean; asset?: string; jobId?: string; owner?: string }) {
  const { output } = roots(request.chatId);
  switch (request.action) {
    case 'status': return blenderState(request.chatId);
    case 'install': await installBlender(); notify(event, request.chatId); return blenderState(request.chatId);
    case 'choose': {
      const picked = await dialog.showOpenDialog({ title: 'Choose Blender', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Blender', extensions: ['exe'] }] } : {}) });
      if (!picked.canceled && picked.filePaths[0]) rememberBlender(await checkBlender(picked.filePaths[0]));
      return blenderState(request.chatId);
    }
    case 'build': return build(event, request.chatId, request.scene, request.render !== false, request.owner);
    case 'render': {
      const state = blenderState(request.chatId);
      if (!state.scene) throw new Error('Create a scene first.');
      return build(event, request.chatId, state.scene, true, request.owner);
    }
    case 'cancel': {
      const job = jobs.get(request.chatId);
      if (job && (!request.jobId || request.jobId === job.id) && (!request.owner || request.owner === job.owner)) stop(job);
      return { ok: true };
    }
    case 'asset': {
      const name = request.asset === 'model' ? 'model.glb' : request.asset === 'render' ? 'render.png' : '';
      const current = currentOutput(output);
      if (!name || !current) throw new Error('No such 3D output.');
      const file = path.join(current, name);
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Preview exceeds 32 MB. Open the scene in Blender.');
      return { data: fs.readFileSync(file).toString('base64'), mimeType: name.endsWith('png') ? 'image/png' : 'model/gltf-binary' };
    }
    case 'export': {
      const name = request.asset === 'model' ? 'model.glb' : request.asset === 'render' ? 'render.png' : request.asset === 'blend' ? 'scene.blend' : '';
      const directory = currentOutput(output);
      if (!name || !directory || !fs.existsSync(path.join(directory, name))) throw new Error('Build this output first.');
      const selected = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: '3D output', extensions: [path.extname(name).slice(1)] }] });
      if (!selected.canceled && selected.filePath) await fs.promises.copyFile(path.join(directory, name), selected.filePath);
      return { ok: true };
    }
    case 'open': {
      const executable = findBlender(); const directory = currentOutput(output);
      if (!executable || !directory) throw new Error('Build a scene first.');
      const child = spawn(executable, ['--disable-autoexec', path.join(directory, 'scene.blend')], { detached: true, windowsHide: false, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); return { ok: true };
    }
    default: throw new Error('Unknown Blender action.');
  }
}
