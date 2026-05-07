// TTS Worker Thread — runs kokoro-js ONNX inference off the main thread
import { parentPort } from 'worker_threads';
import { KokoroTTS } from 'kokoro-js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let _tts: KokoroTTS | null = null;

type WrkMsg =
  | { type: 'init' }
  | { type: 'generate'; id: number; text: string; voice: string; speed: number; volume: number }
  | { type: 'cancel'; id: number }
  | { type: 'unload' };

type WrkOutMsg =
  | { type: 'ready'; voices: string[] }
  | { type: 'start'; id: number; total: number }
  | { type: 'chunk'; id: number; index: number; total: number; base64: string }
  | { type: 'done'; id: number; total: number }
  | { type: 'error'; id: number; message: string };

let _activeId: number | null = null;

function post(data: WrkOutMsg) {
  parentPort?.postMessage(data);
}

function encodePcmBase64(samples: Float32Array, volume: number): string {
  const vol = Math.max(0, Math.min(2, volume));
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * vol));
    pcm[i] = Math.round(s * 32767);
  }
  const bytes = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    bytes.writeInt16LE(pcm[i], i * 2);
  }
  return bytes.toString('base64');
}

/** Generate ~200ms of silence at 24kHz sample rate */
function silenceSamples(durationMs: number): Float32Array {
  const count = Math.round(24000 * durationMs / 1000);
  return new Float32Array(count);
}

parentPort?.on('message', async (msg: WrkMsg) => {
  try {
    switch (msg.type) {
      case 'init': {
        if (!_tts) {
          _tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
          post({ type: 'ready', voices: Object.keys(_tts.voices) });
        } else {
          post({ type: 'ready', voices: Object.keys(_tts.voices) });
        }
        break;
      }

      case 'generate': {
        if (!_tts) { post({ type: 'error', id: msg.id, message: 'Not initialized' }); break; }

        // Cancel any in-flight generation
        _activeId = msg.id;

        // Estimate total chunks upfront for progress reporting
        const textWords = msg.text.split(/\s+/).length;
        const estimatedChunks = Math.max(1, Math.ceil(textWords / 15)); // ~15 words per chunk

        post({ type: 'start', id: msg.id, total: estimatedChunks });

        // Look-ahead pipeline: always generate chunk N+1 before sending chunk N
        // so the next chunk is ready while the previous one is being transmitted.
        const iterator = _tts.stream(msg.text, { voice: msg.voice, speed: msg.speed });
        let sentenceIndex = 0;
        let sentCount = 0;

        // Generate the first chunk
        const first = await iterator.next();
        if (first.done) {
          post({ type: 'done', id: msg.id, total: 0 });
          _activeId = null;
          break;
        }

        let pendingAudio = first.value.audio.audio as Float32Array;

        for await (const sentence of iterator) {
          // Abort if this generation was superseded
          if (_activeId !== msg.id) break;

          // At this point: we have sentence (N+1) generated, and pendingAudio (N) ready to send
          // Send chunk N while the iterator has already prepared N+1
          const base64 = encodePcmBase64(pendingAudio, msg.volume);
          post({
            type: 'chunk',
            id: msg.id,
            index: sentenceIndex,
            total: estimatedChunks,
            base64,
          });
          sentCount = sentenceIndex + 1;

          // Hold the next chunk's audio to send in the next iteration
          pendingAudio = sentence.audio.audio as Float32Array;
          sentenceIndex++;
        }

        // Send the last remaining chunk if not cancelled
        if (_activeId === msg.id) {
          const lastBase64 = encodePcmBase64(pendingAudio, msg.volume);
          post({
            type: 'chunk',
            id: msg.id,
            index: sentenceIndex,
            total: estimatedChunks,
            base64: lastBase64,
          });
          sentCount = sentenceIndex + 1;

          post({ type: 'done', id: msg.id, total: sentCount });
        }
        _activeId = null;
        break;
      }

      case 'cancel': {
        _activeId = null;
        break;
      }

      case 'unload': {
        _tts = null;
        break;
      }
    }
  } catch (err: unknown) {
    const id = 'id' in msg && typeof msg.id === 'number' ? msg.id : 0;
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', id, message });
  }
});