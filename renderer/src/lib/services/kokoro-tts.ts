// TTS voice utilities — synthesis via IPC to main process (kokoro-js ONNX, RTF ~1.0x)
// All 54 voices from Kokoro-82M v1.0-ONNX are bundled in node_modules/kokoro-js/voices/

const KOKORO_VOICE_PREFIXES = [
  'af_', 'am_', 'bf_', 'bm_',
  'ef_', 'em_', 'ff_', 'hf_', 'hm_',
  'if_', 'im_', 'jf_', 'jm_',
  'pf_', 'pm_', 'zf_', 'zm_',
];

export function isKokoroVoice(voice: string): boolean {
  const v = voice.toLowerCase();
  return KOKORO_VOICE_PREFIXES.some(p => v.startsWith(p));
}

// ── Voice metadata types ─────────────────────────────────────────────────────

export type VoiceGender = 'female' | 'male';

export interface KokoroVoice {
  id: string;
  name: string;
  gender: VoiceGender;
  langCode: string;
}

export interface KokoroLanguage {
  code: string;
  label: string;
  voices: KokoroVoice[];
}

// ── Language mapping (first letter of voice ID → BCP-47 code) ────────────────

const VOICE_LANG_PREFIX: Record<string, string> = {
  a: 'en-US', b: 'en-GB', e: 'es', f: 'fr',
  h: 'hi', i: 'it', j: 'ja', p: 'pt-BR', z: 'zh-CN',
};

const VOICE_GENDER_PREFIX: Record<string, VoiceGender> = {
  f: 'female', m: 'male',
};

// ── All 54 verified voice IDs from Kokoro-82M v1.0-ONNX ──────────────────────

const VOICE_IDS: string[] = [
  // American English — 20 voices (11F, 9M)
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
  'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  // British English — 8 voices (4F, 4M)
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  // Spanish — 3 voices (1F, 2M)
  'ef_dora', 'em_alex', 'em_santa',
  // French — 1 voice (1F)
  'ff_siwis',
  // Hindi — 4 voices (2F, 2M)
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  // Italian — 2 voices (1F, 1M)
  'if_sara', 'im_nicola',
  // Japanese — 5 voices (4F, 1M)
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  // Brazilian Portuguese — 3 voices (1F, 2M)
  'pf_dora', 'pm_alex', 'pm_santa',
  // Mandarin Chinese — 8 voices (4F, 4M)
  'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
];

function buildVoice(id: string): KokoroVoice {
  const langPrefix = id[0];
  const genderLetter = id[1];
  const namePart = id.slice(2);
  const name = namePart.charAt(0).toUpperCase() + namePart.slice(1);
  return {
    id,
    name,
    gender: VOICE_GENDER_PREFIX[genderLetter] ?? 'female',
    langCode: VOICE_LANG_PREFIX[langPrefix] ?? 'en-US',
  };
}

const ALL_VOICES: KokoroVoice[] = VOICE_IDS.map(buildVoice);

// ── Language catalog ─────────────────────────────────────────────────────────

const LANGUAGE_LABELS: Record<string, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'es':    'Spanish',
  'fr':    'French',
  'hi':    'Hindi',
  'it':    'Italian',
  'ja':    'Japanese',
  'pt-BR': 'Portuguese (BR)',
  'zh-CN': 'Chinese (CN)',
};

export const KOKORO_LANGUAGES: KokoroLanguage[] = Object.entries(LANGUAGE_LABELS)
  .map(([code, label]) => ({
    code,
    label,
    voices: ALL_VOICES.filter(v => v.langCode === code),
  }))
  .filter(lang => lang.voices.length > 0);

// Backward-compatible catalog consumed by VoiceLanguageSelector
export const KOKORO_QUALITY_VOICES: Record<string, { voices: string[]; label: string }> =
  Object.fromEntries(
    KOKORO_LANGUAGES.map(lang => [
      lang.code,
      { label: lang.label, voices: lang.voices.map(v => v.id) },
    ])
  );

export function getAvailableLanguages(): string[] {
  return Object.keys(KOKORO_QUALITY_VOICES);
}

export function getVoiceInfo(voiceId: string): KokoroVoice | null {
  return ALL_VOICES.find(v => v.id === voiceId) ?? null;
}

export function getVoicesForLanguage(langCode: string): KokoroVoice[] {
  return KOKORO_LANGUAGES.find(l => l.code === langCode)?.voices ?? [];
}

export const DEFAULT_VOICE = 'af_heart';
