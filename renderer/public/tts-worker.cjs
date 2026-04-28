// Kokoro TTS Web Worker — runs in renderer process with nodeIntegrationInWorker
// Accesses onnxruntime-node via require(), runs ONNX inference off UI thread
const { KokoroTTS } = require('kokoro-js');

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let TTS = null;

function post(data, transfer) {
  self.postMessage(data, transfer || []);
}

function encodePcmBase64(samples, volume) {
  const vol = Math.max(0, Math.min(2, volume));
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(samples[i] * vol * 32767)));
    buf.writeInt16LE(s, i * 2);
  }
  return buf.toString('base64');
}

function splitSentences(text) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if ('.!?\n'.includes(ch)) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

self.onmessage = async function (e) {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        if (TTS) {
          post({ type: 'ready', voices: Object.keys(TTS.voices) });
          return;
        }
        TTS = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
        post({ type: 'ready', voices: Object.keys(TTS.voices) });
        break;

      case 'generate': {
        if (!TTS) { post({ type: 'error', id: msg.id, message: 'Not initialized' }); break; }
        const sentences = splitSentences(msg.text);
        for (let i = 0; i < sentences.length; i++) {
          const result = await TTS.generate(sentences[i], {
            voice: msg.voice,
            speed: msg.speed,
          });
          const base64 = encodePcmBase64(result.audio, msg.volume || 1);
          post({ type: 'chunk', id: msg.id, index: i, total: sentences.length, base64 });
        }
        post({ type: 'done', id: msg.id, total: sentences.length });
        break;
      }

      case 'unload':
        TTS = null;
        break;
    }
  } catch (err) {
    post({ type: 'error', id: (msg).id || 0, message: err.message || String(err) });
  }
};
