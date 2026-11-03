import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { getAppPaths } from '../paths.ts';
import { RENDER_VIEWS, sceneSchema, type BlenderState, type DesignScene, type SceneInspection } from '../../shared/design-3d.ts';
import { screenScript } from '../../shared/design-script.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { workspaceRoot, ensureWorkspace } from './workspace.ts';
import { runDesignFileTool } from './tools.ts';
import { BLENDER_INSPECT_SCRIPT, BLENDER_SCRIPT, BLENDER_SCRIPT_HEAD, BLENDER_SCRIPT_TAIL } from './blender-script.ts';
import { checkBlender, findBlender, installBlender, isInstallingBlender, rememberBlender } from './blender-engine.ts';
import { blenderHardwareInfo } from '../../shared/blender-hardware.ts';

type Job = { id: string; owner?: string; process?: ChildProcess; log: string; stopped: boolean; phase: string };
const hardwareInfo = () => blenderHardwareInfo(os.totalmem(), os.freemem(), os.cpus().length);
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
  else { try { process.kill(-job.process.pid, 'SIGKILL'); } catch { job.process.kill('SIGKILL'); } }
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
function outputViews(directory?: string): string[] {
  if (!directory) return [];
  try {
    return fs.readdirSync(path.join(directory, 'views'))
      .filter(name => name.endsWith('.png'))
      .map(name => name.slice(0, -4))
      .filter(name => (RENDER_VIEWS as readonly string[]).includes(name));
  } catch { return []; }
}
function readInspection(directory?: string): SceneInspection | undefined {
  if (!directory) return;
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'inspection.json'), 'utf8')) as SceneInspection; } catch { return; }
}
/** The user's explicit Off remains authoritative; Blender tasks support Python. */
function scriptAllowed(): boolean {
  const config = loadConfig() as { design?: { allowScript?: boolean } };
  return config.design?.allowScript !== false;
}
function setScriptAllowed(allow: boolean): void {
  const config = loadConfig() as { design?: Record<string, unknown> };
  config.design = { ...(config.design ?? {}), allowScript: allow };
  saveConfig(config as unknown as Parameters<typeof saveConfig>[0]);
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
    views: outputViews(directory), inspection: readInspection(directory), scriptAllowed: scriptAllowed(),
    hardware: hardwareInfo(), updatedAt: directory ? fs.statSync(directory).mtimeMs : undefined
  };
}
function notify(event: IpcMainInvokeEvent, chatId: string) {
  if (!event.sender.isDestroyed()) event.sender.send('design_3d_changed', { chatId });
}

/** Runs Blender without app-imposed CPU, memory, render-size, sample, vertex or time budgets. */
function executeJob(job: Job, executable: string, script: string, args: string[], append: (chunk: Buffer | string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '--background', '--factory-startup', '--disable-autoexec',
      '--python-exit-code', '1', '--python', script, '--', ...args
    ], { cwd: path.dirname(script), windowsHide: true, detached: process.platform !== 'win32', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    job.process = child;
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    child.once('error', reject);
    child.once('close', code => {
      if (job.stopped) reject(new Error('Blender job was stopped.'));
      else if (code !== 0) reject(new Error(`Blender exited (${code}). ${job.log.slice(-2000)}`));
      else resolve();
    });
  });
}

/** Keeps the log, promotes the output that produced a model, and prunes old runs. */
function finishJob(event: IpcMainInvokeEvent, chatId: string, job: Job, directory: string, output: string) {
  try {
    fs.writeFileSync(path.join(directory, 'output.log'), job.log);
    if (!job.stopped && fs.existsSync(path.join(directory, 'model.glb'))) {
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

function startJob(event: IpcMainInvokeEvent, chatId: string, phase: string, owner?: string) {
  if (jobs.has(chatId)) throw new Error('This design already has a Blender job running.');
  if (jobs.size) throw new Error('One Blender job is already running. Wait for it to finish; jobs are serialized to keep the desktop responsive.');
  const executable = findBlender();
  if (!executable) throw new Error('Install or choose Blender in Design → 3D first.');
  const { output } = roots(chatId);
  const job: Job = { id: randomUUID(), owner, log: '', stopped: false, phase };
  const directory = path.join(output, job.id);
  fs.mkdirSync(directory);
  jobs.set(chatId, job); failures.delete(chatId);
  notify(event, chatId);
  let lastUpdate = 0;
  const append = (chunk: Buffer | string) => {
    job.log = (job.log + String(chunk)).slice(-32768);
    if (Date.now() - lastUpdate > 300) { lastUpdate = Date.now(); notify(event, chatId); }
  };
  return { job, directory, output, executable, append };
}

async function build(event: IpcMainInvokeEvent, chatId: string, input: unknown, render: boolean, owner?: string): Promise<BlenderState> {
  const scene = sceneSchema.parse(input);
  const encoded = JSON.stringify(scene, null, 2);
  if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('Scene exceeds 512 KB.');
  const { workspace } = roots(chatId);
  const saved = runDesignFileTool(workspace, 'design_write', { path: 'scene.json', content: encoded });
  if (!saved.ok) throw new Error(saved.content);
  const { job, directory, output, executable, append } = startJob(event, chatId, render ? 'Building and rendering' : 'Building model', owner);
  const script = path.join(directory, 'build.py');
  const source = path.join(directory, 'scene.json');
  fs.writeFileSync(script, BLENDER_SCRIPT);
  fs.writeFileSync(source, encoded);
  const args = [source, directory, render ? '1' : '0'];
  try {
    try { await executeJob(job, executable, script, args, append); }
    catch (error) {
      if (job.stopped || !render || scene.render.engine !== 'eevee') throw error;
      // A background host may have no usable graphics context; Cycles CPU works without one.
      append('\nRetrying with Cycles CPU.\n');
      scene.render.engine = 'cycles';
      fs.writeFileSync(source, JSON.stringify(scene));
      await executeJob(job, executable, script, args, append);
    }
  } catch (error) {
    failures.set(chatId, String(error));
  } finally {
    finishJob(event, chatId, job, directory, output);
  }
  return blenderState(chatId);
}

/**
 * Free-form Blender Python: particles, cloth, geometry nodes, shaders — whatever the
 * declarative scene cannot express. The fixed head and tail own the empty scene and
 * the exports, so the program only has to build the model.
 */
async function runScript(event: IpcMainInvokeEvent, chatId: string, request: { python?: unknown; views?: unknown; render?: boolean; owner?: string }): Promise<BlenderState> {
  if (!scriptAllowed()) throw new Error('Free Blender scripting is off. Turn it on in the 3D panel first.');
  const checked = screenScript(request.python);
  if (!checked.ok) throw new Error(checked.reason!);
  const views = Array.isArray(request.views)
    ? request.views.map(String).filter(view => (RENDER_VIEWS as readonly string[]).includes(view))
    : [];
  const { job, directory, output, executable, append } = startJob(event, chatId, 'Building with Blender Python', request.owner);
  const script = path.join(directory, 'script.py');
  const refs = path.join(roots(chatId).workspace, 'references');
  fs.writeFileSync(script, `${BLENDER_SCRIPT_HEAD}\n\n# --- The program the agent wrote -------------------------------------------\n${String(request.python)}\n\n# --- Fixed tail: exports and renders --------------------------------------\n${BLENDER_SCRIPT_TAIL}`);
  try {
    await executeJob(job, executable, script, [
      directory, request.render === false ? '0' : '1',
      JSON.stringify(views.length ? views : ['three_quarter']),
      fs.existsSync(refs) ? refs : ''
    ], append);
  } catch (error) {
    failures.set(chatId, String(error));
  } finally {
    finishJob(event, chatId, job, directory, output);
  }
  return blenderState(chatId);
}

/** Reads what a built scene actually contains, without rendering it. */
async function inspect(event: IpcMainInvokeEvent, chatId: string): Promise<BlenderState> {
  const executable = findBlender();
  const directory = currentOutput(roots(chatId).output);
  if (!executable) throw new Error('Install or choose Blender in Design → 3D first.');
  if (!directory || !fs.existsSync(path.join(directory, 'scene.blend'))) throw new Error('Build a scene first.');
  const script = path.join(directory, 'inspect.py');
  const result = path.join(directory, 'inspection.json');
  fs.writeFileSync(script, BLENDER_INSPECT_SCRIPT);
  const { job, append } = startJob(event, chatId, 'Inspecting Blender scene');
  try {
    await executeJob(job, executable, script, [path.join(directory, 'scene.blend'), result], append);
  } catch (error) { throw new Error(`Inspection failed. ${String(error).slice(-2000)}`); }
  finally { jobs.delete(chatId); notify(event, chatId); }
  return blenderState(chatId);
}

/** Renderer can name an asset, never an absolute path. Binary outputs stay outside HTML snapshots. */
export async function runBlenderRequest(event: IpcMainInvokeEvent, request: {
  chatId: string; action: string; scene?: unknown; render?: boolean; views?: unknown; python?: unknown;
  asset?: string; jobId?: string; owner?: string; allow?: boolean;
}) {
  const { output } = roots(request.chatId);
  switch (request.action) {
    case 'status': return blenderState(request.chatId);
    case 'install': await installBlender(); notify(event, request.chatId); return blenderState(request.chatId);
    case 'choose': {
      const picked = await dialog.showOpenDialog({ title: 'Choose Blender', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Blender', extensions: ['exe'] }] } : {}) });
      if (!picked.canceled && picked.filePaths[0]) rememberBlender(await checkBlender(picked.filePaths[0]));
      return blenderState(request.chatId);
    }
    case 'allow_script': setScriptAllowed(request.allow === true); return blenderState(request.chatId);
    case 'build': return build(event, request.chatId, request.scene, request.render !== false, request.owner);
    case 'render': {
      const state = blenderState(request.chatId);
      if (!state.scene) throw new Error('Create a scene first.');
      return build(event, request.chatId, state.scene, true, request.owner);
    }
    case 'script': return runScript(event, request.chatId, request);
    case 'inspect': return inspect(event, request.chatId);
    case 'cancel': {
      const job = jobs.get(request.chatId);
      if (job && (!request.jobId || request.jobId === job.id) && (!request.owner || request.owner === job.owner)) stop(job);
      return { ok: true };
    }
    case 'asset': {
      const view = request.asset?.startsWith('view:') ? request.asset.slice(5) : '';
      const name = request.asset === 'model' ? 'model.glb' : request.asset === 'render' ? 'render.png'
        : (RENDER_VIEWS as readonly string[]).includes(view) ? path.join('views', `${view}.png`) : '';
      const current = currentOutput(output);
      if (!name || !current) throw new Error('No such 3D output.');
      const file = path.join(current, name);
      if (!fs.existsSync(file)) throw new Error('No such 3D output.');
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('Preview exceeds 32 MB. Open the scene in Blender.');
      return { data: fs.readFileSync(file).toString('base64'), mimeType: name.endsWith('.png') ? 'image/png' : 'model/gltf-binary' };
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
