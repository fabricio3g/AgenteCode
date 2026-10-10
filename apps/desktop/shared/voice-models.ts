// The voice models Desktop offers, run by the bundled audio.cpp server.
//
// Two are featured and described here by hand (their voices, languages and
// eSpeak needs). The rest of the catalog is read at runtime from audio.cpp's
// own model specs (main/voice/voice-catalog.ts), so it always matches what
// the bundled engine can run. The user downloads the ones they want from
// Settings → Voice.

export type VoiceModelId = string;

export interface VoiceOption {
  id: string;
  /** Shown in the picker. */
  label: string;
  language: string;
  /** Unknown for catalog voices audio.cpp only names. */
  gender?: 'female' | 'male';
}

export interface VoiceModel {
  id: VoiceModelId;
  /** audio.cpp model family. */
  family: string;
  title: string;
  license: string;
  /** Hugging Face repo and its main file (downloaded with the app's resumable downloader). */
  repo: string;
  file: string;
  /** Every file the model needs, when it is more than `file` (repo paths). */
  files?: string[];
  /** Repo folder the files sit under; dropped from the local path. */
  stripPrefix?: string;
  /** One line from audio.cpp's spec, for catalog models. */
  description?: string;
  /** audio.cpp's maturity label: supported, community, testing, experimental. */
  status?: string;
  /** Hand-described and recommended (Kokoro, Supertonic). */
  featured?: boolean;
  /** Speaks only in a voice cloned from a recording (no built-in voices). */
  needsReference?: boolean;
  /** Can speak in a voice cloned from a short recording (audio.cpp `voice_ref`). */
  canClone?: boolean;
  /** Cloning needs the clip's transcript (audio.cpp `reference_text`, e.g. F5-TTS, GLM-TTS, ZipVoice). */
  needsTranscript?: boolean;
  /** Another package (quantization or size) of the model with this id; the list shows them as one row. */
  variantOf?: string;
  /** Which package this is, e.g. `Q4_K` or `0.6b base · Q8_0`. */
  variant?: string;
  /** The audio.cpp server task it loads under: `clon` for models that only speak in a cloned voice. */
  serverTask?: 'tts' | 'clon';

  sizeMb: number;
  /** Language codes the model speaks. */
  languages: string[];
  voices: VoiceOption[];
  /** Needs the system eSpeak-ng library for these languages (others work without it). */
  espeakLanguages: string[];
}


/** A voice cloned from a recording: a WAV clip the engine imitates. */
export interface ClonedVoice {
  id: string;
  name: string;
  /** Absolute path of the WAV clip (in the app's voice models folder). */
  file: string;
  /** What the clip says; some models clone more accurately with it. */
  transcript?: string;
  seconds?: number;
}

const SUPERTONIC_LANGUAGES = [
  'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi', 'ja', 'ko', 'vi', 'id',
  'sv', 'da', 'fi', 'cs', 'sk', 'sl', 'hr', 'hu', 'ro', 'bg', 'el', 'et', 'lt', 'lv'
];

const supertonicVoices: VoiceOption[] = [1, 2, 3, 4, 5].flatMap((n) => [
  { id: `F${n}`, label: `Voice F${n}`, language: '*', gender: 'female' as const },
  { id: `M${n}`, label: `Voice M${n}`, language: '*', gender: 'male' as const }
]);

/** Kokoro voice ids: the prefix is language + gender (af = American English, female). */
const KOKORO_VOICES: Record<string, string[]> = {
  'en-us': ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky', 'af_nova', 'af_alloy', 'af_aoede', 'af_jessica', 'af_kore', 'af_river',
    'am_michael', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_onyx', 'am_puck'],
  'en-gb': ['bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily', 'bm_george', 'bm_daniel', 'bm_fable', 'bm_lewis'],
  es: ['ef_dora', 'em_alex'],
  fr: ['ff_siwis'],
  hi: ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'],
  it: ['if_sara', 'im_nicola'],
  ja: ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'],
  'pt-br': ['pf_dora', 'pm_alex'],
  zh: ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang']
};

function kokoroLabel(id: string): string {
  const name = id.slice(3);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const kokoroVoices: VoiceOption[] = Object.entries(KOKORO_VOICES).flatMap(([language, ids]) =>
  ids.map((id) => ({ id, label: kokoroLabel(id), language, gender: id[1] === 'f' ? ('female' as const) : ('male' as const) }))
);

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: 'supertonic-3',
    featured: true,
    status: 'supported',
    family: 'supertonic',
    title: 'Supertonic 3',
    license: 'OpenRAIL-M',
    repo: 'audio-cpp/audio.cpp-gguf',
    file: 'Supertonic-3-GGUF/supertonic-3-f16.gguf',
    sizeMb: 313,
    languages: SUPERTONIC_LANGUAGES,
    voices: supertonicVoices,
    espeakLanguages: []
  },
  {
    id: 'kokoro-82m',
    featured: true,
    status: 'community',
    family: 'kokoro_tts',
    title: 'Kokoro 82M',
    license: 'Apache-2.0',
    repo: 'audio-cpp/audio.cpp-gguf',
    file: 'Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf',
    sizeMb: 190,
    languages: Object.keys(KOKORO_VOICES),
    voices: kokoroVoices,
    espeakLanguages: ['en-us', 'en-gb', 'es', 'fr', 'hi', 'it', 'pt-br']
  }
];

export function voiceModel(id: string | undefined): VoiceModel | undefined {
  return VOICE_MODELS.find((model) => model.id === id);
}

/** Every repo file a model needs. */
export function voiceModelFiles(model: VoiceModel): string[] {
  return model.files?.length ? model.files : [model.file];
}

/** Where one of a model's files lives under the app's voice models folder. */
export function voiceFileRelPath(model: VoiceModel, file: string): string {
  const prefix = model.stripPrefix ? `${model.stripPrefix.replace(/\/+$/, '')}/` : '';
  const inside = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file.split('/').pop()!;
  return `audiocpp/${model.id}/${inside}`;
}

/** What the server loads: the file for a one-file model, else the model's folder. */
export function voiceModelRelPath(model: VoiceModel): string {
  const files = voiceModelFiles(model);
  return files.length > 1 ? `audiocpp/${model.id}` : voiceFileRelPath(model, files[0]);
}

/** The language a Kokoro voice speaks, from its prefix; Supertonic takes any. */
export function voiceLanguage(model: VoiceModel, voiceId: string, fallback: string): string {
  return model.voices.find((voice) => voice.id === voiceId && voice.language !== '*')?.language ?? fallback;
}
