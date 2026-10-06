import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AudioEffect, DomainPack, MediaAssetRef } from '../../shared/domains.ts';
import { operation, projectOperations, reference, effectSchema, positive, type OperationContext } from './registry.ts';
import { checkAbort, runProcess } from './jobs.ts';
import { confinedFile } from './store.ts';

export const audioPack: Omit<DomainPack, 'tools'> = {
  version: 1, id: 'music', name: 'Music & Sound Design', description: 'Analyze, edit, synthesize and mix local audio in a persistent studio.',
  capabilities: ['Analysis', 'Spectral editing', 'Multitrack studio', 'Synthesis & MIDI', 'Stem separation', 'REAPER'], previewTypes: ['audio', 'midi', 'image'],
  dependencies: [
    { id: 'ffmpeg', label: 'FFmpeg', optional: false, docsUrl: 'https://ffmpeg.org/download.html' },
    { id: 'ffprobe', label: 'FFprobe', optional: false, docsUrl: 'https://ffmpeg.org/download.html' },
    { id: 'audio-engine', label: 'Agente audio engine', optional: true, docsUrl: 'https://github.com/fabricio3g/AgenteCode' },
    { id: 'demucs-python', label: 'Demucs Python environment', optional: true, docsUrl: 'https://github.com/adefossez/demucs' },
    { id: 'reaper', label: 'REAPER', optional: true, docsUrl: 'https://www.reaper.fm/' }
  ]
};
export async function withTemp<T>(ctx: OperationContext, action: (dir: string) => Promise<T>): Promise<T> {
  const base = path.join(ctx.store.root, 'work'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'job-'));
  try { checkAbort(ctx.signal); return await action(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
export async function probe(file: string, ctx: OperationContext): Promise<Record<string, any>> {
  const result = await runProcess(await ctx.binary('ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], ctx);
  return JSON.parse(result.stdout.toString());
}
export async function audioAsset(file: string, name: string, ctx: OperationContext, sourceId?: string): Promise<MediaAssetRef> {
  checkAbort(ctx.signal); const info = await probe(file, ctx); const stream = info.streams?.find((s: any) => s.codec_type === 'audio');
  if (!stream) throw new Error('The file has no audio stream.');
  const asset = await ctx.store.asset(file, name, 'audio', name.endsWith('.wav') ? 'audio/wav' : 'audio/*', sourceId);
  Object.assign(asset, { duration: Number(info.format?.duration ?? stream.duration ?? 0), sampleRate: Number(stream.sample_rate ?? 0), channels: Number(stream.channels ?? 0) });
  await fs.writeFile(path.join(ctx.store.root, 'assets', `${asset.id}.json`), JSON.stringify(asset)); return asset;
}
export function effectFilters(effects: AudioEffect[]): string[] {
  return effects.map(e => {
    switch (e.type) {
      case 'gain': return `volume=${e.db}dB`;
      case 'eq': return `equalizer=f=${e.frequency}:t=q:w=${e.q}:g=${e.gain}`;
      case 'highpass': return `highpass=f=${e.frequency}`;
      case 'lowpass': return `lowpass=f=${e.frequency}`;
      case 'compressor': return `acompressor=threshold=${Math.max(0.00097563, Math.pow(10, e.threshold / 20))}:ratio=${e.ratio}:attack=${e.attack}:release=${e.release}:makeup=1`;
      case 'limiter': return `alimiter=limit=${Math.max(0.0625, Math.pow(10, e.ceiling / 20))}:level=0`;
      case 'denoise': return `afftdn=nr=${Math.max(0.01, e.strength)}`;
      case 'fade': return `afade=t=${e.direction}:st=${e.start}:d=${e.duration}`;
      case 'spectral': {
        const gain = Math.pow(10, e.gainDb / 20);
        const mask = `if(between(pts,${e.start},${e.end})*between(b*sr/nb,${e.lowHz},${e.highHz}),${gain},1)`;
        return `afftfilt=real='re*${mask}':imag='im*${mask}':win_size=2048:overlap=0.75`;
      }
    }
  });
}
const target = z.object({ projectId: reference, expectedRevision: z.number().int().nonnegative() });
export const audioOperations = [
  ...projectOperations(),
  operation('create_project', 'Create a persistent local studio project.', 'write', z.object({ title: z.string().min(1).max(200) }), [], async (a, c) => c.store.create('music', a.title)),
  operation('import', 'Import a workspace audio file into this project as an immutable asset.', 'write', target.extend({ path: z.string().min(1).max(4096) }), ['ffprobe'], async (a, c) => {
    c.update('Importing audio'); const source = await confinedFile(c.workspaceRoot, a.path); const asset = await audioAsset(source, path.basename(source), c);
    const project = await c.store.read(a.projectId);
    return c.store.patch({ projectId: a.projectId, expectedRevision: a.expectedRevision, label: `Import ${asset.name}`, changes: { assets: project.assets.some(v => v.id === asset.id) ? project.assets : [...project.assets, asset] } });
  }),
  operation('inspect', 'Measure audio loudness, true peak, RMS, clipping statistics and silence with timestamps. Preserve each channel.', 'read', z.object({ assetId: reference }), ['ffmpeg', 'ffprobe'], async (a, c) => {
    const asset = await c.store.getAsset(a.assetId); c.update('Measuring loudness and channels');
    const result = await runProcess(await c.binary('ffmpeg'), ['-hide_banner', '-nostdin', '-i', asset.path, '-af', 'astats=metadata=0:reset=0,silencedetect=noise=-50dB:d=0.3,loudnorm=print_format=json', '-f', 'null', '-'], c);
    const json = result.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
    const loudness = json ? JSON.parse(json) : null;
    const silence = [...result.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)].map(m => ({ edge: m[1], time: Number(m[2]) }));
    return { asset, loudness, silence, channelStatistics: result.stderr.split('\n').filter(line => /Channel:|Peak level dB:|RMS level dB:|Peak count:|DC offset:/.test(line)).map(line => line.replace(/^\[[^\]]+\]\s*/, '')), method: 'FFmpeg loudnorm/astats/silencedetect', statisticsAfterNormalization: false };
  }),
  operation('waveform', 'Get a bounded waveform region, min/max peaks per channel and exact time bounds. Use regions for long recordings.', 'read', z.object({ assetId: reference, start: z.number().nonnegative().default(0), duration: positive.max(600).default(30), bins: z.number().int().min(64).max(4096).default(1024) }), ['ffmpeg'], async (a, c) => {
    const asset = await c.store.getAsset(a.assetId); const sampleRate = 8000; const channels = Math.min(asset.channels || 1, 8); const peaks = Array.from({ length: channels }, () => Array.from({ length: a.bins }, () => [0, 0]));
    let remainder = Buffer.alloc(0); let frame = 0;
    await runProcess(await c.binary('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', String(a.start), '-i', asset.path, '-t', String(a.duration), '-ar', String(sampleRate), '-ac', String(channels), '-f', 'f32le', '-'], c, { stdout: chunk => {
      const bytes = Buffer.concat([remainder, chunk]); const complete = bytes.length - bytes.length % (channels * 4);
      for (let offset = 0; offset < complete; offset += channels * 4) { const bin = Math.min(a.bins - 1, Math.floor(frame * a.bins / (sampleRate * a.duration))); for (let ch = 0; ch < channels; ch++) { const v = bytes.readFloatLE(offset + ch * 4); peaks[ch][bin][0] = Math.min(peaks[ch][bin][0], v); peaks[ch][bin][1] = Math.max(peaks[ch][bin][1], v); } frame++; }
      remainder = bytes.subarray(complete);
    } });
    return { start: a.start, duration: frame / sampleRate, bins: a.bins, channels: peaks };
  }),
  operation('spectrogram', 'Render a frequency/time spectrogram of a bounded region. Returns a local image asset and calibrated axis bounds.', 'read', z.object({ assetId: reference, start: z.number().nonnegative().default(0), duration: positive.max(600).default(30), width: z.number().int().min(256).max(2048).default(1024), height: z.number().int().min(128).max(1024).default(512) }), ['ffmpeg'], async (a, c) => withTemp(c, async dir => {
    const asset = await c.store.getAsset(a.assetId); const file = path.join(dir, 'spectrogram.png'); c.update('Rendering spectrogram');
    await runProcess(await c.binary('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', String(a.start), '-i', asset.path, '-t', String(a.duration), '-lavfi', `showspectrumpic=s=${a.width}x${a.height}:legend=0:scale=log:fscale=lin:color=intensity`, '-frames:v', '1', '-y', file], c);
    return { asset: await c.store.asset(file, 'spectrogram.png', 'image', 'image/png', asset.id), axes: { start: a.start, end: a.start + Math.min(a.duration, Math.max(0, (asset.duration ?? a.duration) - a.start)), lowHz: 0, highHz: (asset.sampleRate || 48000) / 2, frequencyScale: 'linear' }, dbScale: 'logarithmic amplitude' };
  })),
  operation('process', 'Render trimming or a validated effect chain to a new WAV asset. Original media is unchanged. Spectral edits affect only the selected time/frequency region.', 'write', z.object({ assetId: reference, start: z.number().nonnegative().optional(), duration: positive.optional(), effects: z.array(effectSchema).max(100), name: z.string().min(1).max(200).default('processed.wav') }), ['ffmpeg', 'ffprobe'], async (a, c) => withTemp(c, async dir => {
    const asset = await c.store.getAsset(a.assetId); const file = path.join(dir, 'processed.wav'); const args = ['-v', 'error', '-nostdin'];
    if (a.start !== undefined) args.push('-ss', String(a.start)); args.push('-i', asset.path); if (a.duration !== undefined) args.push('-t', String(a.duration));
    const filters = effectFilters(a.effects); if (filters.length) args.push('-af', filters.join(',')); args.push('-c:a', 'pcm_f32le', '-y', file); c.update('Processing audio');
    await runProcess(await c.binary('ffmpeg'), args, c); return audioAsset(file, `${a.name.replace(/\.wav$/i, '')}.wav`, c, asset.id);
  })),
  operation('synthesize', 'Generate reproducible local oscillator/noise sound with frequency sweep and envelope; no cloud model is used.', 'write', z.object({ waveform: z.enum(['sine', 'triangle', 'square', 'saw', 'noise']).default('sine'), duration: positive.max(120), frequency: z.number().min(10).max(20000).default(440), endFrequency: z.number().min(10).max(20000).optional(), gainDb: z.number().min(-96).max(-1).default(-12), seed: z.number().int().min(1).max(4294967295).default(1), attack: z.number().nonnegative().max(10).default(0.01), release: z.number().nonnegative().max(10).default(0.1) }), [], async (a, c) => withTemp(c, async dir => {
    const rate = 48000; const samples = Math.floor(a.duration * rate); const data = Buffer.alloc(samples * 4); let phase = 0; let seed = a.seed;
    c.update('Synthesizing sound');
    for (let i = 0; i < samples; i++) {
      if (i % 65536 === 0) { checkAbort(c.signal); await new Promise(resolve => setImmediate(resolve)); }
      const t = i / rate; const hz = a.frequency * Math.pow((a.endFrequency ?? a.frequency) / a.frequency, t / a.duration); phase = (phase + hz / rate) % 1;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = a.waveform === 'noise' ? seed / 2147483648 - 1 : a.waveform === 'sine' ? Math.sin(phase * Math.PI * 2) : a.waveform === 'triangle' ? 1 - 4 * Math.abs(phase - 0.5) : a.waveform === 'square' ? (phase < 0.5 ? 1 : -1) : phase * 2 - 1;
      const envelope = Math.min(1, a.attack ? t / a.attack : 1, a.release ? (a.duration - t) / a.release : 1); data.writeFloatLE(value * envelope * Math.pow(10, a.gainDb / 20), i * 4);
    }
    const header = wavHeader(data.length, rate, 1); const file = path.join(dir, 'synth.wav'); await fs.writeFile(file, Buffer.concat([header, data]));
    return c.store.asset(file, 'synth.wav', 'audio', 'audio/wav');
  })),
  operation('separate', 'Separate vocals, drums, bass and accompaniment using an installed local Demucs environment. Outputs remain local.', 'write', z.object({ assetId: reference, device: z.enum(['cpu', 'cuda']).default('cpu') }), ['demucs-python', 'ffmpeg'], async (a, c) => withTemp(c, async dir => {
    const asset = await c.store.getAsset(a.assetId); c.update('Separating stems locally');
    await runProcess(await c.binary('demucs-python'), ['-m', 'demucs', '-n', 'htdemucs', '--device', a.device, '--out', dir, asset.path], c);
    const folders = await fs.readdir(path.join(dir, 'htdemucs')); const stemDir = path.join(dir, 'htdemucs', folders[0]); const stems: MediaAssetRef[] = [];
    for (const name of await fs.readdir(stemDir)) if (name.endsWith('.wav')) stems.push(await audioAsset(path.join(stemDir, name), name, c, asset.id));
    return { stems, model: 'htdemucs', device: a.device };
  }))
];
export function wavHeader(bytes: number, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(bytes + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 4, 28); h.writeUInt16LE(channels * 4, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40); return h;
}
