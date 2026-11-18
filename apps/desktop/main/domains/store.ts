import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CreativeProject, MediaAssetRef, MediaKind, ProjectPatch } from '../../shared/domains.ts';

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
function checkedId(id: string): string { if (!ID.test(id)) throw new Error('Invalid local asset or project reference'); return id; }
async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2)); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function confinedFile(root: string | undefined, requested: string): Promise<string> {
  if (!root) throw new Error('Import an attachment in Domains or select a workspace first.');
  const realRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(realRoot, requested));
  const relative = path.relative(realRoot, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Source must be inside the owning workspace.');
  if (!(await fs.stat(target)).isFile()) throw new Error('Source is not a regular file.');
  return target;
}
type StoredProject = { project: CreativeProject; undo: CreativeProject[]; redo: CreativeProject[] };
export class DomainStore {
  private locks = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}
  private file(id: string) { return path.join(this.root, 'projects', `${checkedId(id)}.json`); }
  async list(): Promise<CreativeProject[]> {
    const dir = path.join(this.root, 'projects'); await fs.mkdir(dir, { recursive: true });
    const projects = await Promise.all((await fs.readdir(dir)).filter(n => n.endsWith('.json')).map(async n => {
      try { return (JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as StoredProject).project; } catch { return null; }
    }));
    return projects.filter((p): p is CreativeProject => !!p).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async read(id: string): Promise<CreativeProject> { return structuredClone((await this.stored(id)).project); }
  private async stored(id: string): Promise<StoredProject> { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
  async create(domain: string, title: string): Promise<CreativeProject> {
    const now = Date.now();
    const project: CreativeProject = { version: 1, id: crypto.randomUUID(), domain, title, revision: 0, createdAt: now, updatedAt: now, assets: [], renders: [], sampleRate: 48000, bpm: 120, tracks: [], markers: [] };
    await atomicJson(this.file(project.id), { project, undo: [], redo: [] }); return project;
  }
  private async serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    checkedId(id); const before = this.locks.get(id) ?? Promise.resolve();
    const next = before.catch(() => {}).then(run); this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async patch(patch: ProjectPatch): Promise<CreativeProject> {
    return this.serial(patch.projectId, async () => {
      const stored = await this.stored(patch.projectId);
      if (stored.project.revision !== patch.expectedRevision) throw new Error(`Project changed: expected revision ${patch.expectedRevision}, current ${stored.project.revision}. Read it again before editing.`);
      const project = { ...stored.project, ...structuredClone(patch.changes), revision: stored.project.revision + 1, updatedAt: Date.now() };
      stored.undo.push(stored.project); stored.undo = stored.undo.slice(-100); stored.redo = []; stored.project = project;
      await atomicJson(this.file(project.id), stored); return structuredClone(project);
    });
  }
  async history(id: string, expectedRevision: number, direction: 'undo' | 'redo'): Promise<CreativeProject> {
    return this.serial(id, async () => {
      const stored = await this.stored(id);
      if (stored.project.revision !== expectedRevision) throw new Error('Project changed; refresh before undo or redo.');
      const source = stored[direction]; const previous = source.pop();
      if (!previous) throw new Error(`Nothing to ${direction}.`);
      stored[direction === 'undo' ? 'redo' : 'undo'].push(stored.project);
      stored.project = { ...previous, revision: stored.project.revision + 1, updatedAt: Date.now() };
      await atomicJson(this.file(id), stored); return structuredClone(stored.project);
    });
  }
  async asset(file: string, name: string, kind: MediaKind, mime: string, sourceId?: string): Promise<MediaAssetRef> {
    const hash = crypto.createHash('sha256'); const handle = await fs.open(file, 'r');
    try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close(); }
    const sha256 = hash.digest('hex'); const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const id = `${sha256}${ext.replace('.', '_')}`; const dir = path.join(this.root, 'assets'); await fs.mkdir(dir, { recursive: true });
    const destination = path.join(dir, `${sha256}${ext}`);
    await fs.copyFile(file, destination, fs.constants.COPYFILE_EXCL).catch(async error => { if (error.code !== 'EEXIST') throw error; });
    const asset: MediaAssetRef = { id, kind, name, mime, bytes: (await fs.stat(destination)).size, sha256, path: destination, createdAt: Date.now(), ...(sourceId ? { sourceId } : {}) };
    const metadata = path.join(dir, `${id}.json`);
    try { return JSON.parse(await fs.readFile(metadata, 'utf8')); } catch { await atomicJson(metadata, asset); return asset; }
  }
  async getAsset(id: string): Promise<MediaAssetRef> { return JSON.parse(await fs.readFile(path.join(this.root, 'assets', `${checkedId(id)}.json`), 'utf8')); }
  async storageBytes(): Promise<number> {
    const dir = path.join(this.root, 'assets');
    try { const sizes = await Promise.all((await fs.readdir(dir)).map(async n => (await fs.stat(path.join(dir, n))).size)); return sizes.reduce((a, b) => a + b, 0); } catch { return 0; }
  }
  async publishRender(id: string, expectedRevision: number, asset: MediaAssetRef): Promise<CreativeProject> {
    return this.serial(id, async () => {
      const stored = await this.stored(id);
      if (stored.project.revision !== expectedRevision) throw new Error('Project changed while rendering. The completed asset is preserved; render the current revision again.');
      stored.project.renders.push(asset); await atomicJson(this.file(id), stored); return stored.project;
    });
  }
}
