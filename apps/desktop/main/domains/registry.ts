import { z } from 'zod';
import type { DomainPack, DomainOperation } from '../../shared/domains.ts';
import type { DomainStore } from './store.ts';
import type { JobContext } from './jobs.ts';
export interface OperationContext extends JobContext { store: DomainStore; workspaceRoot?: string; binary(id: string): Promise<string> }
export interface RegisteredOperation { descriptor: DomainOperation; schema: z.ZodType; run(args: any, ctx: OperationContext): Promise<unknown> }
export class DomainRegistry {
  private packs = new Map<string, DomainPack>();
  private operations = new Map<string, RegisteredOperation>();
  register(pack: Omit<DomainPack, 'tools'>, operations: RegisteredOperation[]): void {
    if (this.packs.has(pack.id)) throw new Error(`Duplicate domain ${pack.id}`);
    const names = new Set<string>();
    for (const op of operations) { if (names.has(op.descriptor.name)) throw new Error(`Duplicate operation ${op.descriptor.name}`); names.add(op.descriptor.name); this.operations.set(`${pack.id}:${op.descriptor.name}`, op); }
    this.packs.set(pack.id, { ...pack, tools: operations.map(op => op.descriptor).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  list(): DomainPack[] { return [...this.packs.values()].map(p => structuredClone(p)); }
  get(id: string): DomainPack { const pack = this.packs.get(id); if (!pack) throw new Error(`Unknown domain ${id}`); return structuredClone(pack); }
  operation(domain: string, name: string): RegisteredOperation { const op = this.operations.get(`${domain}:${name}`); if (!op) throw new Error(`Unknown operation ${domain}.${name}; use domain_tools first.`); return op; }
}
export function operation<T extends z.ZodType>(name: string, description: string, policy: 'read' | 'write', schema: T, dependencies: string[], run: (args: z.output<T>, ctx: OperationContext) => Promise<unknown>): RegisteredOperation {
  const json = z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>; delete json.$schema;
  return { descriptor: { name, description, policy, schema: json, dependencies }, schema, run };
}
export const reference = z.string().min(1).max(100);
export const positive = z.number().finite().positive();
export const effectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gain'), db: z.number().min(-96).max(24) }),
  z.object({ type: z.literal('eq'), frequency: z.number().min(10).max(24000), gain: z.number().min(-48).max(24), q: z.number().min(0.1).max(30) }),
  z.object({ type: z.enum(['highpass', 'lowpass']), frequency: z.number().min(10).max(24000) }),
  z.object({ type: z.literal('compressor'), threshold: z.number().min(-96).max(0), ratio: z.number().min(1).max(20), attack: z.number().min(0.1).max(2000), release: z.number().min(1).max(9000) }),
  z.object({ type: z.literal('limiter'), ceiling: z.number().min(-24).max(0) }),
  z.object({ type: z.literal('denoise'), strength: z.number().min(0).max(97) }),
  z.object({ type: z.literal('fade'), start: z.number().nonnegative(), duration: positive, direction: z.enum(['in', 'out']) }),
  z.object({ type: z.literal('spectral'), start: z.number().nonnegative(), end: positive, lowHz: positive, highHz: positive, gainDb: z.number().min(-96).max(0) }).refine(v => v.end > v.start && v.highHz > v.lowHz, 'Invalid spectral selection')
]);
const point = z.object({ time: z.number().finite().nonnegative(), value: z.number().finite() });
const trackSchema = z.object({
  id: reference, name: z.string().max(200), kind: z.enum(['audio', 'midi', 'bus']), gainDb: z.number().min(-96).max(24), pan: z.number().min(-1).max(1), mute: z.boolean(), solo: z.boolean(),
  clips: z.array(z.object({ id: reference, assetId: reference, start: z.number().nonnegative(), offset: z.number().nonnegative(), duration: positive, gainDb: z.number().min(-96).max(24) })).max(10000),
  notes: z.array(z.object({ pitch: z.number().int().min(0).max(127), start: z.number().nonnegative(), duration: positive, velocity: z.number().min(0).max(1) })).max(100000),
  effects: z.array(effectSchema).max(100), output: reference.optional(), sends: z.array(z.object({ trackId: reference, gainDb: z.number().min(-96).max(24) })).max(100),
  automation: z.object({ gain: z.array(point).max(100000), pan: z.array(point).max(100000) }),
  instrument: z.object({ waveform: z.enum(['sine', 'triangle', 'saw', 'square']), attack: z.number().nonnegative().max(10), release: z.number().nonnegative().max(10), sampleId: reference.optional() }).optional()
});
export function projectOperations(): RegisteredOperation[] {
  return [
    operation('projects', 'List saved projects; they survive agent turns and disabling a domain.', 'read', z.object({}), [], async (_a, c) => c.store.list()),
    operation('project', 'Read a project and its current revision before making changes.', 'read', z.object({ projectId: reference }), [], async (a, c) => c.store.read(a.projectId)),
    operation('patch', 'Apply a named, revision-checked project transaction. Undo retains the previous state. Asset IDs must already belong to this project.', 'write', z.object({ projectId: reference, expectedRevision: z.number().int().nonnegative(), label: z.string().min(1).max(200), changes: z.object({ assets: z.array(z.object({ id: reference }).passthrough()).max(10000).optional(), title: z.string().min(1).max(200).optional(), bpm: z.number().min(20).max(400).optional(), sampleRate: z.union([z.literal(22050), z.literal(44100), z.literal(48000), z.literal(96000)]).optional(), tracks: z.array(trackSchema).max(256).optional(), markers: z.array(z.object({ id: reference, time: z.number().nonnegative(), label: z.string().max(300) })).max(10000).optional(), selection: z.object({ start: z.number().nonnegative(), end: positive, lowHz: positive.optional(), highHz: positive.optional() }).optional(), scene: z.record(z.string(), z.unknown()).optional() }).strict() }), [], async (a, c) => {
      const current = await c.store.read(a.projectId); const resolvedAssets = a.changes.assets ? await Promise.all(a.changes.assets.map(asset => c.store.getAsset(asset.id))) : current.assets; const assets = new Set(resolvedAssets.map(v => v.id)); const tracks = a.changes.tracks;
      if (tracks) {
        const ids = new Set(tracks.map(t => t.id)); if (ids.size !== tracks.length) throw new Error('Track IDs must be unique.');
        for (const t of tracks) { for (const clip of t.clips) if (!assets.has(clip.assetId)) throw new Error(`Import asset ${clip.assetId} into this project first.`); if (t.instrument?.sampleId && !assets.has(t.instrument.sampleId)) throw new Error('Sampler asset is missing.'); if (t.output && !ids.has(t.output)) throw new Error('Output bus is missing.'); for (const send of t.sends) if (!ids.has(send.trackId)) throw new Error('Send bus is missing.'); }
      }
      return c.store.patch({ ...a, changes: { ...a.changes, ...(a.changes.assets ? { assets: resolvedAssets } : {}) } });
    }),
    operation('undo', 'Undo one project transaction at the current revision.', 'write', z.object({ projectId: reference, expectedRevision: z.number().int().nonnegative() }), [], async (a, c) => c.store.history(a.projectId, a.expectedRevision, 'undo')),
    operation('redo', 'Redo one project transaction at the current revision.', 'write', z.object({ projectId: reference, expectedRevision: z.number().int().nonnegative() }), [], async (a, c) => c.store.history(a.projectId, a.expectedRevision, 'redo'))
  ];
}
