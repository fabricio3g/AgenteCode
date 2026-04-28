// Test: worker_threads + kokoro-js in Node.js (no Electron)
// Run: cd renderer && node ../test-tts-worker.mjs

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Worker code as a string (to avoid file path issues)
const workerCode = `
const { parentPort } = require('worker_threads');
const { KokoroTTS } = require('kokoro-js');

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      if (tts) return parentPort.postMessage({ type: 'ready' });
      console.log('[Worker] Loading model...');
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
      console.log('[Worker] Ready,', Object.keys(tts.voices).length, 'voices');
      parentPort.postMessage({ type: 'ready' });
    } else if (msg.type === 'generate') {
      if (!tts) throw new Error('Not initialized');
      const text = msg.text;
      const voice = msg.voice || 'af_heart';
      const speed = msg.speed || 1;
      
      // Split into sentences
      const sentences = [];
      let cur = '';
      for (const ch of text) {
        cur += ch;
        if ('.!?\\n'.includes(ch)) { const t = cur.trim(); if (t) sentences.push(t); cur = ''; }
      }
      if (cur.trim()) sentences.push(cur.trim());
      if (!sentences.length) sentences.push(text);
      
      console.log('[Worker] Generating', sentences.length, 'sentences...');
      const start = performance.now();
      
      for (let i = 0; i < sentences.length; i++) {
        const result = await tts.generate(sentences[i], { voice, speed });
        parentPort.postMessage({
          type: 'chunk',
          id: msg.id,
          index: i,
          total: sentences.length,
          samples: result.audio,
          sampleRate: result.sampling_rate,
        });
      }
      
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log('[Worker] Done in', elapsed + 's');
      parentPort.postMessage({ type: 'done', id: msg.id, total: sentences.length, elapsed });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: err.message });
  }
});
`;

const worker = new Worker(workerCode, { eval: true });

worker.on('message', (msg) => {
  if (msg.type === 'ready') console.log('[Main] Worker ready, loading model...');
  else if (msg.type === 'chunk') {
    const dur = (msg.samples.length / msg.sampleRate).toFixed(1);
    console.log(`[Main] Chunk ${msg.index + 1}/${msg.total}: ${dur}s audio`);
  }
  else if (msg.type === 'done') console.log(`[Main] All done (${msg.elapsed}s)`);
  else if (msg.type === 'error') console.error('[Main] Error:', msg.message);
});

worker.on('error', (err) => console.error('[Main] Worker crashed:', err));
worker.on('exit', (code) => console.log('[Main] Worker exited:', code));

console.log('[Main] Starting test...');
worker.postMessage({ type: 'init' });

// Wait for model to load, then test synthesis
setTimeout(() => {
  console.log('\n[Main] === Testing synthesis ===');
  worker.postMessage({
    type: 'generate',
    id: 1,
    text: 'Hello world. This is a test of kokoro text to speech running in a worker thread. We are measuring performance and stability.',
    voice: 'af_heart',
    speed: 1,
  });
}, 60000); // Wait up to 60s for model download

// Also test second and third generations
setTimeout(() => {
  console.log('\n[Main] === Test 2 ===');
  worker.postMessage({
    type: 'generate',
    id: 2,
    text: 'The quick brown fox jumps over the lazy dog. This sentence is used to test voice quality and clarity.',
    voice: 'af_bella',
    speed: 1,
  });
}, 120000);

setTimeout(() => {
  console.log('\n[Main] === Test 3 ===');
  worker.postMessage({
    type: 'generate',
    id: 3,
    text: 'This is the final test to ensure repeated synthesis works without errors or memory leaks.',
    voice: 'am_michael',
    speed: 1.1,
  });
}, 180000);
