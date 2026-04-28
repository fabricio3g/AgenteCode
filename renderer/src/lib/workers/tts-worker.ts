import { KokoroTTS, env } from 'kokoro-js';

env.wasmPaths = new URL('/src/lib/wasm/', self.location.href).href;

type WorkerMessage =
  | { type: 'init'; modelId: string; dtype: string; device: string }
  | { type: 'synthesize'; text: string; voice: string; speed: number }
  | { type: 'listVoices' }
  | { type: 'unload' };

type WorkerResponse =
  | { type: 'progress'; data: any }
  | { type: 'ready'; voices: string[] }
  | { type: 'result'; samples: Float32Array; sampleRate: number; duration: number }
  | { type: 'voices'; voices: string[] }
  | { type: 'error'; message: string };

let tts: KokoroTTS | null = null;

function post(msg: WorkerResponse, transfer?: Transferable[]) {
  (self as any).postMessage(msg, transfer ?? []);
}

async function initTts(modelId: string, dtype: string, _device: string): Promise<KokoroTTS> {
  post({ type: 'progress', data: { status: 'init', message: 'Loading model via WASM...' } });
  return KokoroTTS.from_pretrained(modelId, {
    dtype: dtype as any,
    device: 'wasm' as any,
    progress_callback: (p: any) => post({ type: 'progress', data: p }),
  });
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      case 'init': {
        if (tts) {
          post({ type: 'ready', voices: Object.keys(tts.voices) });
          return;
        }
        tts = await initTts(msg.modelId, msg.dtype, msg.device);
        post({ type: 'ready', voices: Object.keys(tts.voices) });
        break;
      }

      case 'synthesize': {
        if (!tts) throw new Error('TTS not initialized');
        const result = await tts.generate(msg.text, {
          voice: msg.voice as any,
          speed: msg.speed,
        });
        const audio = result.audio as Float32Array;
        const sampleRate = result.sampling_rate;
        const duration = audio.length / sampleRate;
        console.log('[TTS Worker] Audio stats:', {
          length: audio.length,
          min: Math.min(...audio),
          max: Math.max(...audio),
          sampleRate,
          duration: duration.toFixed(2) + 's',
          first5: Array.from(audio.slice(0, 5)),
          mid5: Array.from(audio.slice(Math.floor(audio.length/2), Math.floor(audio.length/2)+5)),
        });
        const samples = new Float32Array(audio);
        post({ type: 'result', samples, sampleRate, duration }, [samples.buffer]);
        break;
      }

      case 'listVoices': {
        if (!tts) throw new Error('TTS not initialized');
        post({ type: 'voices', voices: Object.keys(tts.voices) });
        break;
      }

      case 'unload': {
        tts = null;
        break;
      }
    }
  } catch (err: any) {
    post({ type: 'error', message: err.message || String(err) });
  }
};
