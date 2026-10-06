import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { DomainConfig, DomainStatus, MediaJob, MediaAssetRef } from '../../shared/domains.ts';
import { DomainStore } from './store.ts';
import { DomainRegistry, type OperationContext } from './registry.ts';
import { DomainJobs, checkAbort } from './jobs.ts';
import { audioOperations, audioPack } from './audio.ts';
import { studioOperations } from './studio.ts';
import { designPack, designOperations, videoPack, videoOperations, scenePack, sceneOperations } from './creative.ts';

export interface DomainServiceOptions {
  root: string;
  config(): DomainConfig;
  emit?(job: MediaJob): void;
  resolveBinary?(id: string): string | undefined;
}
const requestSchema = z.object({ domain: z.string().min(1).max(100), operation: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) }).strict();
export class DomainService {
  readonly store: DomainStore; readonly jobs: DomainJobs; readonly registry = new DomainRegistry();
  constructor(private options: DomainServiceOptions) {
    this.store = new DomainStore(options.root); this.jobs = new DomainJobs(options.emit);
    this.registry.register(audioPack, [...audioOperations, ...studioOperations]);
    this.registry.register(designPack, designOperations); this.registry.register(videoPack, videoOperations); this.registry.register(scenePack, sceneOperations);
  }
  enabled(id: string): boolean { return this.options.config().enabled[id] === true; }
  private requireEnabled(id: string) { this.registry.get(id); if (!this.enabled(id)) throw new Error(`${id} is disabled. Enable it in Settings → Domains.`); }
  async binary(id: string): Promise<string> {
    const configured = this.options.config().runtimes[id] || this.options.resolveBinary?.(id);
    if (configured) { if (!(await fs.stat(configured)).isFile()) throw new Error(`${id} path is not a file. Choose its executable in Settings → Domains.`); return configured; }
    const candidates = id === 'audio-engine' ? [] : id === 'demucs-python' ? [] : [id];
    for (const candidate of candidates) {
      for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        const file = path.join(directory, process.platform === 'win32' ? `${candidate}.exe` : candidate);
        try { if ((await fs.stat(file)).isFile()) return file; } catch { /* next PATH entry */ }
      }
    }
    throw new Error(`${id} is not installed. Open Settings → Domains and choose or install its local runtime.`);
  }
  async status(): Promise<DomainStatus[]> {
    const projects = await this.store.list();
    return Promise.all(this.registry.list().map(async pack => {
      const availability: DomainStatus['availability'] = {};
      await Promise.all(pack.dependencies.map(async dependency => {
        try { availability[dependency.id] = { available: true, path: await this.binary(dependency.id) }; }
        catch (error) { availability[dependency.id] = { available: false, error: (error as Error).message }; }
      }));
      const ids = new Set(projects.filter(p => p.domain === pack.id).flatMap(p => [...p.assets, ...p.renders].map(a => a.id)));
      const assets = await Promise.all([...ids].map(id => this.store.getAsset(id).catch(() => null)));
      return { ...pack, enabled: this.enabled(pack.id), availability, storageBytes: assets.reduce((n, a) => n + (a?.bytes || 0), 0) };
    }));
  }
  async tool(name: string, raw: Record<string, unknown>, owner: string, signal: AbortSignal, workspaceRoot?: string): Promise<unknown> {
    if (name === 'domain_catalog') return (await this.status()).filter(p => p.enabled).map(({ id, name, description, capabilities, availability }) => ({ id, name, description, capabilities, availability }));
    if (name === 'domain_tools') { const { domain } = z.object({ domain: z.string() }).strict().parse(raw); this.requireEnabled(domain); return this.registry.get(domain); }
    if (name !== 'domain_read' && name !== 'domain_write') throw new Error('Unknown domain tool.');
    const request = requestSchema.parse(raw); this.requireEnabled(request.domain);
    const operation = this.registry.operation(request.domain, request.operation);
    const policy = name === 'domain_read' ? 'read' : 'write';
    if (operation.descriptor.policy !== policy) throw new Error(`${request.operation} requires domain_${operation.descriptor.policy}.`);
    const args = operation.schema.parse(request.args);
    const projectId = (args as { projectId?: string }).projectId;
    if (projectId && (await this.store.read(projectId)).domain !== request.domain) throw new Error('This project belongs to a different domain.');
    for (const dependency of operation.descriptor.dependencies) await this.binary(dependency);
    return this.jobs.run(request.domain, request.operation, owner, signal, async job => {
      checkAbort(job.signal);
      const context: OperationContext = { ...job, store: this.store, workspaceRoot, binary: id => this.binary(id) };
      return operation.run(args, context);
    });
  }
  async preview(assetId: string): Promise<{ mime: string; bytes: Uint8Array }> {
    const asset = await this.store.getAsset(assetId);
    // Only small previews travel over IPC. Audio/video playback uses local file URLs.
    if (asset.bytes > 16 * 1024 * 1024) throw new Error('Use local playback for this asset; it is too large for a preview.');
    return { mime: asset.mime, bytes: await fs.readFile(asset.path) };
  }
  async importBytes(name: string, bytes: Uint8Array, kind: MediaAssetRef['kind']): Promise<MediaAssetRef> {
    if (!this.registry.list().some(p => this.enabled(p.id) && p.previewTypes.includes(kind))) throw new Error('Enable a matching domain in Settings first.');
    if (bytes.byteLength > 512 * 1024 * 1024) throw new Error('Use a local workspace path for files larger than 512 MB.');
    const dir = path.join(this.store.root, 'work'); await fs.mkdir(dir, { recursive: true }); const file = path.join(dir, `${crypto.randomUUID()}.import`);
    try { await fs.writeFile(file, bytes); return await this.store.asset(file, path.basename(name), kind, mimeOf(name)); } finally { await fs.rm(file, { force: true }); }
  }
}
export function mimeOf(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return ({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mid': 'audio/midi', '.blend': 'application/x-blender', '.glb': 'model/gltf-binary' } as Record<string, string>)[extension] || 'application/octet-stream';
}
