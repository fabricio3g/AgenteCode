// Local voice model catalogs (Kokoro TTS, whisper.cpp STT) and their install
// state. The remote catalog (fetch_model_catalog) can add or override
// entries; the fallbacks below keep the page useful offline.

import { fetchModelCatalog } from '$lib/services/search';
import { getModelsDirPath } from '$lib/services/models';
import { pathExists } from '$lib/services/files';
import { isElectron } from '$lib/services/bridge';

export type VoiceModelKind = 'tts' | 'stt';

export interface VoiceModelEntry {
  key: string;
  kind: VoiceModelKind;
  label: string;
  description: string;
  repo_id: string;
  dir: string;
  files: string[];
  /** Download destination prefix under the models dir ('' for TTS, 'whisper/' for STT). */
  destPrefix: string;
  size_mb?: number;
  downloaded: boolean;
  is_active: boolean;
  recommended?: boolean;
  engine?: string;
  voices?: string[];
  model_path?: string;
  voices_path?: string;
  tokens_path?: string;
  lexicon_path?: string;
  dict_dir?: string;
  data_dir?: string;
}

const TTS_FALLBACK: Record<string, any> = {
  kokoro_v11: {
    label: 'Kokoro v1.1 Multi-language (High Quality)', description: '103 voices, 9 languages, improved quality. Recommended.',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main',
    dir: 'kokoro-multi-lang-v1_1', engine: 'kokoro', size_mb: 170,
    model_file: 'model.int8.onnx', tokens_file: 'tokens.txt',
    voices_file: 'voices.bin', lexicon_file: 'lexicon-us-en.txt',
    files: ['model.int8.onnx', 'voices.bin', 'tokens.txt',
            'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'lexicon-zh.txt',
            'date-zh.fst', 'number-zh.fst', 'phone-zh.fst',
            'dict/hmm_model.utf8', 'dict/idf.utf8', 'dict/jieba.dict.utf8',
            'dict/stop_words.utf8', 'dict/user.dict.utf8'],
    voices: [
      'af_maple', 'af_sol', 'bf_vale',
      'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007', 'zf_008',
      'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024',
      'zf_026', 'zf_027', 'zf_032', 'zf_036', 'zf_038', 'zf_039',
      'zf_040', 'zf_042', 'zf_043', 'zf_044', 'zf_046', 'zf_047', 'zf_048',
      'zf_049', 'zf_051', 'zf_059', 'zf_060', 'zf_067', 'zf_070', 'zf_071',
      'zf_072', 'zf_073', 'zf_074', 'zf_075', 'zf_076', 'zf_077', 'zf_078',
      'zf_079', 'zf_083', 'zf_084', 'zf_085', 'zf_086', 'zf_087', 'zf_088',
      'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099',
      'zm_009', 'zm_010', 'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015',
      'zm_016', 'zm_020', 'zm_025', 'zm_029', 'zm_030', 'zm_031', 'zm_033',
      'zm_034', 'zm_035', 'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052',
      'zm_053', 'zm_054', 'zm_055', 'zm_056', 'zm_057', 'zm_058', 'zm_061',
      'zm_062', 'zm_063', 'zm_064', 'zm_065', 'zm_066', 'zm_068', 'zm_069',
      'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091', 'zm_095', 'zm_096',
      'zm_097', 'zm_098', 'zm_100',
    ],
  },
  kokoro_82m_v1: {
    label: 'Kokoro Multi-lang v1.0', description: '53 voices across 9 languages (EN, JP, ZH, ES, FR, HI, IT, PT)',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_0', branch: 'main',
    dir: 'kokoro-multi-lang-v1_0', engine: 'kokoro', size_mb: 160,
    model_file: 'model.int8.onnx', tokens_file: 'tokens.txt',
    voices_file: 'voices.bin', lexicon_file: 'lexicon-us-en.txt',
    files: ['model.int8.onnx', 'voices.bin', 'tokens.txt',
            'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'lexicon-zh.txt',
            'date-zh.fst', 'number-zh.fst', 'phone-zh.fst',
            'dict/hmm_model.utf8', 'dict/idf.utf8', 'dict/jieba.dict.utf8',
            'dict/stop_words.utf8', 'dict/user.dict.utf8'],
    voices: [
      'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
      'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
      'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
      'am_michael', 'am_onyx', 'am_puck', 'am_santa',
      'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
      'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
      'ef_dora', 'em_alex', 'ff_siwis',
      'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
      'if_sara', 'im_nicola',
      'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
      'pf_dora', 'pm_alex', 'pm_santa',
      'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
      'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
    ],
  },
};

const WHISPER_FALLBACK: Record<string, any> = {
  tiny_q5: {
    label: 'Tiny (Q5_1)', description: 'Fastest, 99 languages',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    files: ['ggml-tiny-q5_1.bin'],
    size_mb: 32, speed: 'Fastest', quality: 'Basic',
  },
  base_q5: {
    label: 'Base (Q5_1)', description: 'Fast, 99 languages',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    files: ['ggml-base-q5_1.bin'],
    size_mb: 62, speed: 'Fast', quality: 'Good',
  },
  small_q5: {
    label: 'Small (Q5_1)', description: 'Balanced, 99 languages',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    files: ['ggml-small-q5_1.bin'],
    size_mb: 206, speed: 'Medium', quality: 'Better',
  },
  medium_q5: {
    label: 'Medium (Q5_0) — Recommended', description: 'Best balance, 99 languages',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    files: ['ggml-medium-q5_0.bin'],
    size_mb: 539, speed: 'Slower', quality: 'Best',
  },
  large_v3_q5: {
    label: 'Large v3 (Q5_0)', description: 'Highest accuracy, 99 languages',
    repo: 'ggerganov/whisper.cpp',
    dir: 'whisper-ggml',
    files: ['ggml-large-v3-q5_0.bin'],
    size_mb: 1100, speed: 'Slowest', quality: 'Best+',
  },
};


function normalizeSizeMb(meta: any): number | undefined {
  const direct = Number(meta?.size_mb ?? meta?.sizeMB);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const bytes = Number(meta?.size_bytes ?? meta?.bytes ?? meta?.size);
  if (Number.isFinite(bytes) && bytes > 1024 * 1024) return Math.round(bytes / (1024 * 1024));
  const match = String(meta?.size_human || meta?.sizeHuman || '').match(/([\d.]+)\s*(KB|MB|GB)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return unit === 'KB' ? Math.max(1, Math.round(value / 1024)) : unit === 'GB' ? Math.round(value * 1024) : Math.round(value);
}

async function allExist(base: string, files: string[]): Promise<boolean> {
  if (!base || !isElectron()) return false;
  const checks = await Promise.all(files.map((file) => pathExists(`${base}/${file}`)));
  return checks.every(Boolean);
}

/** Both catalogs, merged with the remote one, with install state resolved. */
export async function loadVoiceCatalog(selected: { tts?: string; stt?: string }): Promise<{ tts: VoiceModelEntry[]; stt: VoiceModelEntry[] }> {
  let remote: { tts?: Record<string, any>; whisper?: Record<string, any> } = {};
  try {
    remote = (await fetchModelCatalog()) as typeof remote ?? {};
  } catch {
    /* offline: fallbacks only */
  }
  const modelsDir = isElectron() ? await getModelsDirPath().catch(() => '') : '';

  const tts = await Promise.all(
    [...new Set([...Object.keys(TTS_FALLBACK), ...Object.keys(remote.tts ?? {})])].map(async (key): Promise<VoiceModelEntry> => {
      const meta = { ...(TTS_FALLBACK[key] ?? {}), ...(remote.tts?.[key] ?? {}) };
      const dir = String(meta.dir || key);
      const files: string[] = Array.isArray(meta.files) && meta.files.length
        ? meta.files.map(String)
        : [String(meta.model_file || 'model.onnx'), String(meta.voices_file || 'voices.bin'), String(meta.tokens_file || 'tokens.txt')];
      const base = modelsDir ? `${modelsDir}/${dir}` : '';
      const downloaded = await allExist(base, files);
      return {
        key,
        kind: 'tts',
        label: String(meta.label || key),
        description: String(meta.description || ''),
        repo_id: String(meta.repo_id || meta.repo || ''),
        dir,
        files,
        destPrefix: '',
        size_mb: normalizeSizeMb(meta),
        downloaded,
        is_active: downloaded && key === selected.tts,
        recommended: key === 'kokoro_v11',
        engine: meta.engine,
        voices: meta.voices,
        model_path: `${base}/${files[0]}`,
        voices_path: `${base}/${meta.voices_file || 'voices.bin'}`,
        tokens_path: `${base}/${meta.tokens_file || 'tokens.txt'}`,
        lexicon_path: `${base}/${meta.lexicon_file || 'lexicon.txt'}`,
        dict_dir: `${base}/${meta.dict_dir || 'dict'}`,
        data_dir: `${base}/${meta.data_dir || 'espeak-ng-data'}`
      };
    })
  );

  const stt = await Promise.all(
    [...new Set([...Object.keys(WHISPER_FALLBACK), ...Object.keys(remote.whisper ?? {})])].map(async (key): Promise<VoiceModelEntry> => {
      const meta = { ...(WHISPER_FALLBACK[key] ?? {}), ...(remote.whisper?.[key] ?? {}) };
      const dir = String(meta.dir || `sherpa-onnx-whisper-${key}.en`);
      const files: string[] = Array.isArray(meta.files) && meta.files.length
        ? meta.files.map(String)
        : [`${key}.en-encoder.int8.onnx`, `${key}.en-decoder.int8.onnx`, `${key}.en-tokens.txt`];
      const downloaded = await allExist(modelsDir ? `${modelsDir}/whisper/${dir}` : '', files);
      return {
        key,
        kind: 'stt',
        label: String(meta.label || key).replace(/\s*—\s*Recommended$/i, ''),
        description: String(meta.description || ''),
        repo_id: String(meta.repo_id || meta.repo || `csukuangfj/sherpa-onnx-whisper-${key}.en`),
        dir,
        files,
        destPrefix: 'whisper/',
        size_mb: normalizeSizeMb(meta),
        downloaded,
        is_active: downloaded && key === selected.stt,
        recommended: key === 'medium_q5'
      };
    })
  );

  return { tts, stt };
}
