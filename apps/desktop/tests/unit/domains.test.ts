import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DomainService } from '../../main/domains/service.ts';
import { DomainStore, confinedFile } from '../../main/domains/store.ts';
import { DomainJobs, runProcess } from '../../main/domains/jobs.ts';
import { wavHeader, effectFilters } from '../../main/domains/audio.ts';
import type { CreativeProject } from '../../shared/domains.ts';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agente-domains-'));
  const desktopRoot = path.resolve(import.meta.dirname, '../..');
  const config = { enabled: {} as Record<string, boolean>, runtimes: { ffmpeg: path.join(desktopRoot, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ffprobe: path.join(desktopRoot, 'node_modules/ffprobe-static/bin', process.platform, process.arch, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') } };
  return { root, config, service: new DomainService({ root, config: () => config }), close: () => fs.rm(root, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;
test('all domains default off and server enforces activation and operation policy', async () => {
  const f = await fixture(); try {
    assert.equal(f.service.registry.list().length, 4);
    assert.deepEqual(await f.service.tool('domain_catalog', {}, 'test', signal()), []);
    await assert.rejects(f.service.tool('domain_write', { domain: 'music', operation: 'create_project', args: { title: 'Test' } }, 'test', signal()), /disabled/);
    f.config.enabled.music = true;
    await assert.rejects(f.service.tool('domain_read', { domain: 'music', operation: 'create_project', args: { title: 'Test' } }, 'test', signal()), /requires domain_write/);
    await assert.rejects(f.service.tool('domain_write', { domain: 'music', operation: 'create_project', args: { title: '' } }, 'test', signal()));
    const project = await f.service.tool('domain_write', { domain: 'music', operation: 'create_project', args: { title: 'Test' } }, 'test', signal()) as CreativeProject;
    f.config.enabled.music = false; assert.equal((await f.service.store.read(project.id)).title, 'Test');
    await assert.rejects(f.service.tool('domain_read', { domain: 'music', operation: 'project', args: { projectId: project.id } }, 'test', signal()), /disabled/);
  } finally { await f.close(); }
});
test('revision transactions reject competing edits and undo/redo survive store recovery', async () => {
  const f = await fixture(); try {
    const project = await f.service.store.create('music', 'Original');
    const results = await Promise.allSettled(['First', 'Second'].map(title => f.service.store.patch({ projectId: project.id, expectedRevision: 0, label: title, changes: { title } })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const recovered = new DomainStore(f.root); const current = await recovered.read(project.id); assert.equal(current.revision, 1);
    const undone = await recovered.history(project.id, 1, 'undo'); assert.equal(undone.title, 'Original'); assert.equal(undone.revision, 2);
    const redone = await recovered.history(project.id, 2, 'redo'); assert.equal(redone.title, current.title); assert.equal(redone.revision, 3);
  } finally { await f.close(); }
});
test('file confinement rejects traversal and symlink escapes', async () => {
  const f = await fixture(); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agente-outside-')); try {
    await fs.writeFile(path.join(f.root, 'inside.txt'), 'inside'); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    assert.equal(await confinedFile(f.root, 'inside.txt'), path.join(f.root, 'inside.txt'));
    await assert.rejects(confinedFile(f.root, path.join(outside, 'secret.txt')), /inside/);
    if (process.platform !== 'win32') { await fs.symlink(path.join(outside, 'secret.txt'), path.join(f.root, 'link')); await assert.rejects(confinedFile(f.root, 'link'), /inside/); }
    await assert.rejects(f.service.store.read('../escape'), /Invalid/);
  } finally { await f.close(); await fs.rm(outside, { recursive: true, force: true }); }
});
test('owner cancellation terminates a real local worker and publishes a cancelled result', async () => {
  const updates: string[] = []; const jobs = new DomainJobs(job => updates.push(job.state));
  const result = jobs.run('music', 'worker', 'turn', signal(), context => runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], context));
  await new Promise(resolve => setTimeout(resolve, 100)); jobs.cancelOwner('other'); assert.equal(jobs.list()[0].state, 'running'); jobs.cancelOwner('turn');
  await assert.rejects(result, /stopped/i); assert.ok(updates.includes('cancelled')); assert.ok(!updates.includes('completed'));
});
test('seeded synthesis, original preservation, waveform bounds, and original loudness measurements', async () => {
  const f = await fixture(); try {
    f.config.enabled.music = true;
    const call = (policy: 'read' | 'write', operation: string, args: Record<string, unknown>) => f.service.tool(`domain_${policy}`, { domain: 'music', operation, args }, 'audio', signal());
    const a = await call('write', 'synthesize', { waveform: 'sine', duration: 0.4, frequency: 440, seed: 7 }) as any;
    const b = await call('write', 'synthesize', { waveform: 'sine', duration: 0.4, frequency: 440, seed: 7 }) as any;
    assert.equal(a.sha256, b.sha256); const before = await fs.readFile(a.path);
    const waveform = await call('read', 'waveform', { assetId: a.id, start: 0, duration: 0.4, bins: 128 }) as any;
    assert.equal(waveform.channels[0].length, 128); assert.ok(waveform.duration > 0.39 && waveform.duration <= 0.401);
    const measure = await call('read', 'inspect', { assetId: a.id }) as any;
    assert.ok(Number.isFinite(Number(measure.loudness.input_i))); assert.equal(measure.statisticsAfterNormalization, false);
    const edited = await call('write', 'process', { assetId: a.id, effects: [{ type: 'gain', db: -6 }], name: 'quieter.wav' }) as any;
    assert.notEqual(edited.sha256, a.sha256); assert.deepEqual(await fs.readFile(a.path), before);
    const spectrogram = await call('read', 'spectrogram', { assetId: a.id, start: 0, duration: 0.4, width: 256, height: 128 }) as any;
    assert.equal(spectrogram.asset.kind, 'image'); assert.ok(spectrogram.asset.bytes > 100);
  } finally { await f.close(); }
});
test('effect filters use typed numeric values and finite spectral bounds', () => {
  assert.ok(effectFilters([{ type: 'spectral', start: 1, end: 2, lowHz: 500, highHz: 1000, gainDb: -12 }])[0].includes('afftfilt'));
  assert.equal(wavHeader(400, 48000, 1).readUInt32LE(40), 400);
});
