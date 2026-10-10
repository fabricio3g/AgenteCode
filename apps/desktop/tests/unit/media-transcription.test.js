import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { transcribeMediaFile, transcriptTimestamp } from '../../main/voice/media-transcription.ts';

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agente-media-test-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });
function wav(seconds, name) {
  const size = seconds * 16000 * 2;
  const bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + size, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  const filename = path.join(root, name); fs.writeFileSync(filename, bytes); return filename;
}

describe('uploaded recording transcription', () => {
  it('decodes a long recording into timestamped, bounded Whisper segments', async () => {
    const filename = wav(600, 'long.wav');
    assert.ok(fs.statSync(filename).size > 16 * 1024 * 1024, 'input exceeds dictation upload ceiling');
    let calls = 0;
    const text = await transcribeMediaFile(filename, 'audio/wav', async (bytes) => {
      calls++;
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.ok(bytes.length < 1024 * 1024, 'each 30-second window stays small');
      return `Segment ${calls} source facts.`;
    });
    assert.equal(calls, 20);
    assert.match(text, /## Transcript 00:00:30\n\nSegment 2/);
    assert.match(text, /## Transcript 00:09:30\n\nSegment 20/);
    assert.ok(fs.existsSync(filename), 'the source is retained');
  });

  it('rejects silence and failed segments instead of indexing partial transcripts', async () => {
    const filename = wav(1, 'silent.wav');
    await assert.rejects(transcribeMediaFile(filename, 'audio/wav', async () => ''), /No speech recognized/);
    await assert.rejects(transcribeMediaFile(filename, 'audio/wav', async () => { throw new Error('Whisper unavailable'); }), /Whisper unavailable/);
  });

  it('formats multi-hour transcript locators', () => { assert.equal(transcriptTimestamp(3723), '01:02:03'); });
});
