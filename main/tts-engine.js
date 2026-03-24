import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './index.js';

let _sherpa = null;
const _ttsCache = new Map();

async function getSherpa() {
  if (_sherpa) return _sherpa;
  try {
    _sherpa = await import('sherpa-onnx-node');
    return _sherpa;
  } catch {
    return null;
  }
}

function resolveExistingPath(candidates = []) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    if (fs.existsSync(value)) return value;
  }
  return String(candidates.find((candidate) => String(candidate || '').trim()) || '').trim();
}

function resolveExistingDirectory(candidates = []) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    if (fs.existsSync(value) && fs.statSync(value).isDirectory()) return value;
  }
  return '';
}

function resolveModelDir(request) {
  const { modelsRoot } = getAppPaths();
  const fallbackDirs = [
    'kitten-nano-en-v0_2-fp16',
    'kitten-nano-en-v0_1-fp16',
    'kitten-mini-en-v0_1-fp16',
    'kokoro-multi-lang-v1_1',
    'kokoro-multi-lang-v1_0',
    'kitten-tts-en-nano-0.8',
    'kitten-tts-nano-0.8',
    'kitten-tts-kokoro-multi-lang-v1_0'
  ].map((dir) => path.join(modelsRoot, dir));

  if (request?.model_dir && fs.existsSync(request.model_dir) && fs.statSync(request.model_dir).isDirectory()) {
    return request.model_dir;
  }

  if (request?.model_path && fs.existsSync(request.model_path)) {
    return path.dirname(request.model_path);
  }

  return resolveExistingDirectory(fallbackDirs) || fallbackDirs[0];
}

function buildSherpaConfig(request, modelDir) {
  const engine = request.engine || 'kitten';

  if (engine === 'kokoro') {
    const lexiconCandidates = [];
    if (request.lexicon_path) lexiconCandidates.push(request.lexicon_path);
    try {
      if (fs.existsSync(modelDir)) {
        for (const entry of fs.readdirSync(modelDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (entry.name.startsWith('lexicon') && entry.name.endsWith('.txt')) {
            lexiconCandidates.push(path.join(modelDir, entry.name));
          }
        }
      }
    } catch {
      // ignore directory scan failures and fall back to the explicit path below
    }

    return {
      model: {
        kokoro: {
          model: resolveExistingPath([
            request.model_path,
            path.join(modelDir, 'model.int8.onnx'),
            path.join(modelDir, 'model.onnx'),
            path.join(modelDir, 'model.fp16.onnx')
          ]),
          voices: resolveExistingPath([
            request.voices_path,
            path.join(modelDir, 'voices.bin')
          ]),
          tokens: resolveExistingPath([
            request.tokens_path,
            path.join(modelDir, 'tokens.txt')
          ]),
          dataDir: resolveExistingDirectory([
            request.data_dir,
            path.join(modelDir, 'espeak-ng-data'),
            path.join(path.dirname(modelDir), 'espeak-ng-data')
          ]),
          dictDir: resolveExistingDirectory([
            request.dict_dir,
            path.join(modelDir, 'dict')
          ]),
          lexicon: lexiconCandidates.filter((candidate) => fs.existsSync(candidate)).join(',')
        },
        numThreads: 2,
        debug: 0,
        provider: 'cpu'
      }
    };
  }

  const lexicon = resolveExistingPath([
    request.lexicon_path,
    path.join(modelDir, 'lexicon.txt'),
    path.join(modelDir, 'lexicon-us-en.txt')
  ]);

  return {
    model: {
      vits: {
        model: resolveExistingPath([
          request.model_path,
          path.join(modelDir, 'model.fp16.onnx'),
          path.join(modelDir, 'model.onnx'),
          path.join(modelDir, 'model.int8.onnx')
        ]),
        lexicon: fs.existsSync(lexicon) ? lexicon : '',
        tokens: resolveExistingPath([
          request.tokens_path,
          path.join(modelDir, 'tokens.txt')
        ]),
        dataDir: resolveExistingDirectory([
          request.data_dir,
          path.join(modelDir, 'espeak-ng-data'),
          path.join(path.dirname(modelDir), 'espeak-ng-data')
        ]),
        dictDir: resolveExistingDirectory([
          request.dict_dir,
          path.join(modelDir, 'dict')
        ])
      },
      numThreads: 2,
      debug: 0,
      provider: 'cpu'
    }
  };
}

function encodePcmBase64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, Number(samples[i] || 0)));
    pcm[i] = Math.round(sample * 32767);
  }

  const bytes = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) {
    bytes.writeInt16LE(pcm[i], i * 2);
  }
  return bytes.toString('base64');
}

export async function generateTts(request) {
  const sherpa = await getSherpa();
  if (!sherpa) {
    throw new Error('sherpa-onnx-node not installed. Install it with: npm install sherpa-onnx-node');
  }

  const modelDir = resolveModelDir(request);
  const cacheKey = modelDir;

  let ttsInstance = _ttsCache.get(cacheKey);
  if (!ttsInstance) {
    try {
      const config = buildSherpaConfig(request, modelDir);
      ttsInstance = new sherpa.OfflineTts(config);
      _ttsCache.set(cacheKey, ttsInstance);
      if (_ttsCache.size > 5) {
        const oldestKey = _ttsCache.keys().next().value;
        _ttsCache.delete(oldestKey);
      }
    } catch (err) {
      throw new Error(`Failed to load TTS model from ${modelDir}: ${err.message}`);
    }
  }

  const voice = request.voice || 'Bella';
  const speed = Number(request.speed || 1.0);
  const sid = mapVoiceToSid(voice, request.engine || 'kitten');

  const audio = ttsInstance.generate({ text: request.text, sid, speed });
  if (!audio?.samples) {
    throw new Error('TTS generation did not return audio samples');
  }

  return encodePcmBase64(audio.samples);
}

export async function unloadTts() {
  _ttsCache.clear();
}

export async function checkEspeakData(modelsDir) {
  const candidates = [
    path.join(modelsDir, 'espeak-ng-data'),
    path.join(modelsDir, 'kitten-nano-en-v0_2-fp16', 'espeak-ng-data'),
    path.join(modelsDir, 'kitten-nano-en-v0_1-fp16', 'espeak-ng-data'),
    path.join(modelsDir, 'kitten-mini-en-v0_1-fp16', 'espeak-ng-data'),
    path.join(modelsDir, 'kokoro-multi-lang-v1_0', 'espeak-ng-data'),
    path.join(modelsDir, 'kokoro-multi-lang-v1_1', 'espeak-ng-data'),
    path.join(modelsDir, 'kitten-tts-en-nano-0.8', 'espeak-ng-data'),
    path.join(modelsDir, 'kitten-tts-nano-0.8', 'espeak-ng-data'),
    path.join(modelsDir, 'kitten-tts-kokoro-multi-lang-v1_0', 'espeak-ng-data'),
    '/usr/share/espeak-ng-data',
    '/usr/local/share/espeak-ng-data'
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { found: true, path: p, source: p.startsWith('/usr') ? 'system' : 'bundled' };
    }
  }

  return { found: false };
}

function mapVoiceToSid(voice, engine) {
  if (engine === 'kokoro') {
    const v = String(voice || '').toLowerCase();
    switch (v) {
      case 'af_maple': return 0;
      case 'af_sol': return 1;
      case 'bf_vale': return 2;
      case 'zf_001': return 3;
      case 'zf_002': return 4;
      case 'zf_003': return 5;
      case 'zf_004': return 6;
      case 'zf_005': return 7;
      case 'zf_006': return 8;
      case 'zf_007': return 9;
      case 'zf_008': return 10;
      case 'zf_017': return 11;
      case 'zf_018': return 12;
      case 'zf_019': return 13;
      case 'zf_021': return 14;
      case 'zf_022': return 15;
      case 'zf_023': return 16;
      case 'zf_024': return 17;
      case 'zf_026': return 18;
      case 'zf_027': return 19;
      case 'zf_028': return 20;
      case 'zf_032': return 21;
      case 'zf_036': return 22;
      case 'zf_038': return 23;
      case 'zf_039': return 24;
      case 'zf_040': return 25;
      case 'zf_042': return 26;
      case 'zf_043': return 27;
      case 'zf_044': return 28;
      case 'zf_046': return 29;
      case 'zf_047': return 30;
      case 'zf_048': return 31;
      case 'zf_049': return 32;
      case 'zf_051': return 33;
      case 'zf_059': return 34;
      case 'zf_060': return 35;
      case 'zf_067': return 36;
      case 'zf_070': return 37;
      case 'zf_071': return 38;
      case 'zf_072': return 39;
      case 'zf_073': return 40;
      case 'zf_074': return 41;
      case 'zf_075': return 42;
      case 'zf_076': return 43;
      case 'zf_077': return 44;
      case 'zf_078': return 45;
      case 'zf_079': return 46;
      case 'zf_083': return 47;
      case 'zf_084': return 48;
      case 'zf_085': return 49;
      case 'zf_086': return 50;
      case 'zf_087': return 51;
      case 'zf_088': return 52;
      case 'zf_090': return 53;
      case 'zf_092': return 54;
      case 'zf_093': return 55;
      case 'zf_094': return 56;
      case 'zf_099': return 57;
      case 'zm_009': return 58;
      case 'zm_010': return 59;
      case 'zm_011': return 60;
      case 'zm_012': return 61;
      case 'zm_013': return 62;
      case 'zm_014': return 63;
      case 'zm_015': return 64;
      case 'zm_016': return 65;
      case 'zm_020': return 66;
      case 'zm_025': return 67;
      case 'zm_029': return 68;
      case 'zm_030': return 69;
      case 'zm_031': return 70;
      case 'zm_033': return 71;
      case 'zm_034': return 72;
      case 'zm_035': return 73;
      case 'zm_037': return 74;
      case 'zm_041': return 75;
      case 'zm_045': return 76;
      case 'zm_050': return 77;
      case 'zm_052': return 78;
      case 'zm_053': return 79;
      case 'zm_054': return 80;
      case 'zm_055': return 81;
      case 'zm_056': return 82;
      case 'zm_057': return 83;
      case 'zm_058': return 84;
      case 'zm_061': return 85;
      case 'zm_062': return 86;
      case 'zm_063': return 87;
      case 'zm_064': return 88;
      case 'zm_065': return 89;
      case 'zm_066': return 90;
      case 'zm_068': return 91;
      case 'zm_069': return 92;
      case 'zm_080': return 93;
      case 'zm_081': return 94;
      case 'zm_082': return 95;
      case 'zm_089': return 96;
      case 'zm_091': return 97;
      case 'zm_095': return 98;
      case 'zm_096': return 99;
      case 'zm_097': return 100;
      case 'zm_098': return 101;
      case 'zm_100': return 102;
      case 'af_alloy': return 0;
      case 'af_aoede': return 1;
      case 'af_bella': return 2;
      case 'af_heart': return 3;
      case 'af_jessica': return 4;
      case 'af_kore': return 5;
      case 'af_nicole': return 6;
      case 'af_nova': return 7;
      case 'af_river': return 8;
      case 'af_sarah': return 9;
      case 'af_sky': return 10;
      case 'am_adam': return 11;
      case 'am_echo': return 12;
      case 'am_eric': return 13;
      case 'am_fenrir': return 14;
      case 'am_liam': return 15;
      case 'am_michael': return 16;
      case 'am_onyx': return 17;
      case 'am_puck': return 18;
      case 'am_santa': return 19;
      case 'bf_alice': return 20;
      case 'bf_emma': return 21;
      case 'bf_isabella': return 22;
      case 'bf_lily': return 23;
      case 'bm_daniel': return 24;
      case 'bm_fable': return 25;
      case 'bm_george': return 26;
      case 'bm_lewis': return 27;
      case 'ef_dora': return 28;
      case 'em_alex': return 29;
      case 'ff_siwis': return 30;
      case 'hf_alpha': return 31;
      case 'hf_beta': return 32;
      case 'hm_omega': return 33;
      case 'hm_psi': return 34;
      case 'if_sara': return 35;
      case 'im_nicola': return 36;
      case 'jf_alpha': return 37;
      case 'jf_gongitsune': return 38;
      case 'jf_nezumi': return 39;
      case 'jf_tebukuro': return 40;
      case 'jm_kumo': return 41;
      case 'pf_dora': return 42;
      case 'pm_alex': return 43;
      case 'pm_santa': return 44;
      case 'zf_xiaobei': return 45;
      case 'zf_xiaoni': return 46;
      case 'zf_xiaoxiao': return 47;
      case 'zf_xiaoyi': return 48;
      case 'zm_yunjian': return 49;
      case 'zm_yunxi': return 50;
      case 'zm_yunxia': return 51;
      case 'zm_yunyang': return 52;
      default:
        if (v.startsWith('zf_') || v.startsWith('zm_')) {
          const maybe = Number.parseInt(v.slice(3), 10);
          if (Number.isFinite(maybe)) return maybe;
        }
        return 0;
    }
  }

  switch (String(voice || '').toLowerCase()) {
    case 'jasper': return 0;
    case 'bella': return 1;
    case 'bruno': return 2;
    case 'luna': return 3;
    case 'hugo': return 4;
    case 'rosie': return 5;
    case 'leo': return 6;
    case 'kiki': return 7;
    default: return 0;
  }
}
