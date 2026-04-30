// TTS voice utilities — actual synthesis now via IPC to main process (native ONNX, RTF ~1.0x)

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

// Curated high-quality voices per language.
// NOTE: Non-English voices are currently unavailable due to a limitation
// in the phonemizer.js package (eSpeak-ng WASM only bundles English dictionaries).
// Only English voices are exposed until a multi-language phonemizer is available.
// Language codes: en-US, en-GB
export const KOKORO_QUALITY_VOICES: Record<string, { voices: string[]; label: string }> = {
  'en-US': {
    label: 'English (US)',
    voices: ['af_heart', 'af_bella', 'af_nicole'], // A, A-, B-
  },
  'en-GB': {
    label: 'English (UK)',
    voices: ['bf_emma'], // B-
  },
};

function getQualityVoicesForLanguage(lang: string): string[] {
  return KOKORO_QUALITY_VOICES[lang]?.voices ?? KOKORO_QUALITY_VOICES['en-US'].voices;
}

export function getAvailableLanguages(): string[] {
  return Object.keys(KOKORO_QUALITY_VOICES);
}
