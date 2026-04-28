// Test kokoro-js inference speed in Node.js
import { KokoroTTS, env } from 'kokoro-js';
import { performance } from 'perf_hooks';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const TEXT = 'Hello world. This is a performance benchmark of the Kokoro text to speech system. We want to measure how fast it synthesizes speech.';
const VOICE = 'af_heart';

async function main() {
  console.log('=== Kokoro TTS Node.js Benchmark ===\n');
  console.log('Node version:', process.version);

  // Init model
  const initStart = performance.now();
  console.log('Initializing model...');
  const tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype: 'q8',
    device: 'cpu',
    progress_callback: (p) => {
      if (p.status === 'done') console.log('  Loaded:', p.file);
      else if (p.status === 'progress' && Math.round(p.progress) % 20 === 0)
        console.log('  Download:', Math.round(p.progress) + '%');
    },
  });
  const initTime = (performance.now() - initStart) / 1000;
  const voices = Object.keys(tts.voices);
  console.log(`Init done in ${initTime.toFixed(2)}s, ${voices.length} voices available\n`);

  // Benchmark: 3 runs
  const results = [];
  for (let run = 0; run < 3; run++) {
    const genStart = performance.now();
    const result = await tts.generate(TEXT, { voice: VOICE, speed: 1 });
    const genTime = (performance.now() - genStart) / 1000;
    const audioLen = result.audio.length / result.sampling_rate;

    let peak = 0;
    for (let i = 0; i < result.audio.length; i++) peak = Math.max(peak, Math.abs(result.audio[i]));
    const rtf = genTime / audioLen;

    console.log(`Run ${run + 1}: audio=${audioLen.toFixed(2)}s, time=${genTime.toFixed(2)}s, RTF=${rtf.toFixed(1)}x, peak=${peak.toFixed(3)}`);
    results.push({ genTime, audioLen, rtf, peak });
  }

  // Summary
  const avgRtf = results.reduce((s, r) => s + r.rtf, 0) / results.length;
  const avgTime = results.reduce((s, r) => s + r.genTime, 0) / results.length;
  const avgAudio = results.reduce((s, r) => s + r.audioLen, 0) / results.length;

  console.log(`\n=== SUMMARY ===`);
  console.log(`Avg gen time: ${avgTime.toFixed(2)}s`);
  console.log(`Avg audio dur: ${avgAudio.toFixed(2)}s`);
  console.log(`Avg RTF: ${avgRtf.toFixed(1)}x ${avgRtf < 1 ? '(FASTER than real-time)' : avgRtf < 2 ? '(near real-time)' : '(SLOW)'}`);
  console.log(`Chars per second: ${Math.round(TEXT.length / avgTime)}`);
  console.log(`Total text length: ${TEXT.length} chars`);

  await tts.model.dispose?.();
  console.log('\nDone.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
