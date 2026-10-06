/** Domain capabilities are shared by Settings, Home and the desktop MCP adapter. */
export type DomainId = string;
export type MediaKind = 'audio' | 'image' | 'video' | 'scene' | 'midi';
export interface DomainConfig { enabled: Record<DomainId, boolean>; runtimes: Record<string, string> }
export interface DomainDependency { id: string; label: string; optional: boolean; docsUrl: string }
export interface DomainOperation { name: string; description: string; policy: 'read' | 'write'; schema: Record<string, unknown>; dependencies: string[] }
export interface DomainPack {
  version: 1; id: DomainId; name: string; description: string;
  capabilities: string[]; dependencies: DomainDependency[]; previewTypes: MediaKind[];
  tools: DomainOperation[];
}
export interface DomainStatus extends DomainPack {
  enabled: boolean; storageBytes: number;
  availability: Record<string, { available: boolean; path?: string; version?: string; error?: string }>;
}
export interface MediaAssetRef {
  id: string; kind: MediaKind; name: string; mime: string; bytes: number; sha256: string;
  /** Immutable local reference; never a data URL or bytes in model history. */
  path: string; createdAt: number; sourceId?: string;
  duration?: number; sampleRate?: number; channels?: number; width?: number; height?: number;
}
export type AudioEffect =
  | { type: 'gain'; db: number }
  | { type: 'eq'; frequency: number; gain: number; q: number }
  | { type: 'highpass' | 'lowpass'; frequency: number }
  | { type: 'compressor'; threshold: number; ratio: number; attack: number; release: number }
  | { type: 'limiter'; ceiling: number }
  | { type: 'denoise'; strength: number }
  | { type: 'fade'; start: number; duration: number; direction: 'in' | 'out' }
  | { type: 'spectral'; start: number; end: number; lowHz: number; highHz: number; gainDb: number };
export interface MidiNote { pitch: number; start: number; duration: number; velocity: number }
export interface AudioClip { id: string; assetId: string; start: number; offset: number; duration: number; gainDb: number }
export interface AutomationPoint { time: number; value: number }
export interface StudioTrack {
  id: string; name: string; kind: 'audio' | 'midi' | 'bus'; gainDb: number; pan: number;
  mute: boolean; solo: boolean; clips: AudioClip[]; notes: MidiNote[]; effects: AudioEffect[];
  output?: string; sends: Array<{ trackId: string; gainDb: number }>;
  automation: { gain: AutomationPoint[]; pan: AutomationPoint[] };
  instrument?: { waveform: 'sine' | 'triangle' | 'saw' | 'square'; attack: number; release: number; sampleId?: string };
}
export interface CreativeProject {
  version: 1; id: string; domain: DomainId; title: string; revision: number;
  createdAt: number; updatedAt: number; assets: MediaAssetRef[];
  sampleRate: number; bpm: number; tracks: StudioTrack[];
  markers: Array<{ id: string; time: number; label: string }>;
  selection?: { start: number; end: number; lowHz?: number; highHz?: number };
  renders: MediaAssetRef[];
  scene?: Record<string, unknown>;
}
export interface ProjectPatch {
  projectId: string; expectedRevision: number; label: string;
  changes: Partial<Pick<CreativeProject, 'title' | 'assets' | 'sampleRate' | 'bpm' | 'tracks' | 'markers' | 'selection' | 'scene'>>;
}
export interface MediaJob {
  id: string; owner: string; domain: DomainId; operation: string; projectId?: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string; startedAt: number; endedAt?: number; progress?: number;
  result?: unknown; error?: string;
}
export const DOMAIN_TOOL_NAMES = ['domain_catalog', 'domain_tools', 'domain_read', 'domain_write'] as const;
const argumentsSchema = { type: 'object' as const, additionalProperties: true };
export const DOMAIN_TOOL_DEFS: Array<{ name: string; description: string; parameters: { type: 'object'; properties: Record<string, { type: string; additionalProperties?: boolean }>; required?: string[]; additionalProperties: boolean } }> = [
  { name: 'domain_catalog', description: 'List domain packs enabled in Settings and their local dependencies. Domain tools process media locally. Use domain_tools to discover operations.', parameters: { type: 'object' as const, properties: {}, additionalProperties: false } },
  { name: 'domain_tools', description: 'Get validated operation schemas for one enabled domain. Settings is authoritative; this does not enable domains.', parameters: { type: 'object' as const, properties: { domain: { type: 'string' } }, required: ['domain'], additionalProperties: false } },
  ...(['read', 'write'] as const).map(policy => ({
    name: `domain_${policy}`,
    description: policy === 'read' ? 'Inspect local media or creative projects using a read operation discovered with domain_tools. Returns compact measurements and asset references.' : 'Create, edit or export local creative assets using a write operation discovered with domain_tools. Originals stay intact; project changes require the current expectedRevision.',
    parameters: { type: 'object' as const, properties: { domain: { type: 'string' }, operation: { type: 'string' }, args: argumentsSchema }, required: ['domain', 'operation', 'args'], additionalProperties: false }
  }))
];

export function newStudioTrack(name = 'Track', kind: StudioTrack['kind'] = 'audio'): StudioTrack {
  return { id: crypto.randomUUID(), name, kind, gainDb: 0, pan: 0, mute: false, solo: false, clips: [], notes: [], effects: [], sends: [], automation: { gain: [], pan: [] }, ...(kind === 'midi' ? { instrument: { waveform: 'sine' as const, attack: 0.01, release: 0.1 } } : {}) };
}
