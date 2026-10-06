import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { operation, reference, positive, type OperationContext } from './registry.ts';
import { audioAsset, withTemp } from './audio.ts';
import { runProcess, checkAbort } from './jobs.ts';
import type { CreativeProject, MediaAssetRef } from '../../shared/domains.ts';

async function preparedGraph(project: CreativeProject, directory: string, ctx: OperationContext): Promise<Record<string, unknown>> {
  const sources = new Map<string, string>(); const ffmpeg = await ctx.binary('ffmpeg');
  for (const track of project.tracks) for (const clip of track.clips) if (!sources.has(clip.assetId)) {
    const asset = await ctx.store.getAsset(clip.assetId); const output = path.join(directory, `${sources.size}.wav`);
    ctx.update(`Decoding ${asset.name}`);
    await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-i', asset.path, '-ar', String(project.sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', '-y', output], ctx); sources.set(clip.assetId, output);
  }
  const tracks = [];
  for (const track of project.tracks) {
    const clips = track.clips.map(clip => ({ ...clip, path: sources.get(clip.assetId) }));
    let instrument = track.instrument ? { ...track.instrument } as Record<string, unknown> : undefined;
    if (track.instrument?.sampleId) {
      const asset = await ctx.store.getAsset(track.instrument.sampleId); const output = path.join(directory, `sample-${track.id}.wav`);
      await runProcess(ffmpeg, ['-v', 'error', '-nostdin', '-i', asset.path, '-ar', String(project.sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', '-y', output], ctx); instrument = { ...instrument, samplePath: output };
    }
    // Effects are part of the same persisted graph used for preview and export.
    tracks.push({ ...track, clips, instrument });
  }
  return { sampleRate: project.sampleRate, tracks };
}
export async function renderStudio(project: CreativeProject, ctx: OperationContext): Promise<MediaAssetRef> {
  return withTemp(ctx, async dir => {
    const engine = await ctx.binary('audio-engine'); const graph = await preparedGraph(project, dir, ctx);
    const input = path.join(dir, 'graph.json'); const output = path.join(dir, 'mix.wav');
    await fs.writeFile(input, JSON.stringify(graph)); ctx.update('Rendering multitrack graph');
    await runProcess(engine, ['render', input, output], ctx); checkAbort(ctx.signal);
    return audioAsset(output, `${project.title.replace(/[\\/]/g, '-')}.wav`, ctx);
  });
}
const target = z.object({ projectId: reference, expectedRevision: z.number().int().nonnegative() });
export const studioOperations = [
  operation('render', 'Render the saved multitrack graph, buses, sends, automation and MIDI to a new local WAV. Returns the rendered revision; source assets are preserved.', 'write', target, ['ffmpeg', 'ffprobe', 'audio-engine'], async (a, c) => {
    const project = await c.store.read(a.projectId); if (project.revision !== a.expectedRevision) throw new Error('Project changed; read its current revision before rendering.');
    const asset = await renderStudio(project, c); await c.store.publishRender(project.id, project.revision, asset); return { asset, revision: project.revision };
  }),
  operation('stems', 'Render each source track as an individual local WAV stem with aligned start times.', 'write', target, ['ffmpeg', 'ffprobe', 'audio-engine'], async (a, c) => {
    const project = await c.store.read(a.projectId); if (project.revision !== a.expectedRevision) throw new Error('Project changed; refresh before exporting stems.');
    const assets: MediaAssetRef[] = [];
    for (const track of project.tracks.filter(t => t.kind !== 'bus')) {
      const isolated = { ...project, title: track.name, tracks: [{ ...track, mute: false, solo: false, output: undefined, sends: [] }] };
      assets.push(await renderStudio(isolated, c));
    }
    return { stems: assets, revision: project.revision };
  }),
  operation('spectral_paint', 'Synthesize a painted magnitude spectrogram with reproducible Griffin-Lim phase reconstruction. Points are time seconds, frequency Hz and amplitude 0–1. Phase reconstruction is approximate.', 'write', z.object({ duration: positive.max(60), points: z.array(z.object({ time: z.number().nonnegative(), frequency: z.number().min(0).max(24000), amplitude: z.number().min(0).max(1) })).min(1).max(10000), seed: z.number().int().min(1).max(4294967295).default(1), iterations: z.number().int().min(1).max(64).default(24) }), ['audio-engine', 'ffprobe'], async (a, c) => withTemp(c, async dir => {
    const input = path.join(dir, 'paint.json'); const output = path.join(dir, 'paint.wav'); await fs.writeFile(input, JSON.stringify({ ...a, sampleRate: 48000 })); c.update('Reconstructing painted spectrum');
    await runProcess(await c.binary('audio-engine'), ['paint', input, output], c); return { asset: await audioAsset(output, 'spectral-paint.wav', c), method: 'Griffin-Lim', approximatePhase: true, seed: a.seed };
  })),
  operation('midi_export', 'Export MIDI notes from a project with tempo and exact note timing.', 'write', z.object({ projectId: reference }), [], async (a, c) => withTemp(c, async dir => {
    const project = await c.store.read(a.projectId); const ticks = 480; const events: Array<{ tick: number; bytes: number[] }> = [];
    project.tracks.filter(t => t.kind === 'midi').forEach((track, ch) => { for (const note of track.notes) { const start = Math.round(note.start * project.bpm / 60 * ticks); const end = Math.round((note.start + note.duration) * project.bpm / 60 * ticks); events.push({ tick: start, bytes: [0x90 | (ch % 16), note.pitch, Math.round(note.velocity * 127)] }, { tick: end, bytes: [0x80 | (ch % 16), note.pitch, 0] }); } });
    events.sort((a, b) => a.tick - b.tick || a.bytes[0] - b.bytes[0]);
    const tempo = Math.round(60000000 / project.bpm); const data = [0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]; let previous = 0;
    for (const event of events) { data.push(...variableLength(event.tick - previous), ...event.bytes); previous = event.tick; } data.push(0, 0xff, 0x2f, 0);
    const header = Buffer.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224]); const trackHeader = Buffer.alloc(8); trackHeader.write('MTrk'); trackHeader.writeUInt32BE(data.length, 4);
    const file = path.join(dir, 'notes.mid'); await fs.writeFile(file, Buffer.concat([header, trackHeader, Buffer.from(data)])); return c.store.asset(file, `${project.title}.mid`, 'midi', 'audio/midi');
  }))
];
function variableLength(value: number): number[] { const bytes = [value & 127]; while ((value >>= 7) > 0) bytes.unshift((value & 127) | 128); return bytes; }
