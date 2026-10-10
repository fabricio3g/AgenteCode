/** Uploaded recordings are segmented before Whisper, unlike short dictation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SEGMENT_SECONDS = 30;
const MAX_SEGMENTS = 720; // Six hours; bounded disk use and model calls.

export function transcriptTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
}

export async function transcribeMediaFile(filePath: string, _mime: string, transcribe?: (bytes: Buffer) => Promise<string>): Promise<string> {
  const { default: bundledFfmpeg } = await import('ffmpeg-static');
  const ffmpeg = bundledFfmpeg?.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1') || 'ffmpeg';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agente-transcript-'));
  try {
    // Decode only the audio track, resample once, keep every segment below the
    // STT upload ceiling and its per-call timeout. No shell or renderer paths.
    await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', filePath, '-map', '0:a:0', '-vn',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-t', String((MAX_SEGMENTS + 1) * SEGMENT_SECONDS),
      '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '1',
      path.join(temp, '%05d.wav')], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const segments = (await fs.readdir(temp)).filter((name) => name.endsWith('.wav')).sort();
    if (!segments.length) throw new Error('No audio track found.');
    if (segments.length > MAX_SEGMENTS) throw new Error('Recordings longer than six hours must be split before attaching.');
    const transcribeSegment = transcribe || (async (bytes: Buffer) => {
      const { transcribeAudio } = await import('../stt-engine.ts');
      return String((await transcribeAudio({ audio_bytes: bytes, mime_type: 'audio/wav' })).text || '');
    });
    const parts: string[] = [];
    for (const [index, name] of segments.entries()) {
      const text = (await transcribeSegment(await fs.readFile(path.join(temp, name)))).trim();
      if (text) parts.push(`## Transcript ${transcriptTimestamp(index * SEGMENT_SECONDS)}\n\n${text}`);
      await fs.unlink(path.join(temp, name));
    }
    if (!parts.length) throw new Error('No speech recognized in this recording.');
    return parts.join('\n\n');
  } catch (error) {
    throw new Error(`Could not transcribe recording: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
