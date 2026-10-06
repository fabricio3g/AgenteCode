// The local voice engine: the bundled audio.cpp server and the voice models
// it runs (Kokoro, Supertonic). One status call feeds Settings → Voice,
// Settings → On this computer and the setup wizard.

import { invoke } from './bridge';

export interface SpeechEngineStatus {
  /** Bundled audio.cpp release, e.g. `v0.8.2`; null when the build has no info. */
  version: string | null;
  /** Backends this build ships (`cpu`, `vulkan`). Empty: no engine bundled. */
  backends: string[];
  /** The backend the server runs with. */
  backend: 'cpu' | 'vulkan';
  /** Threads it runs with (the setting, or the automatic choice). */
  threads: number;
  /** This machine's logical cores, the ceiling for the thread setting. */
  cores: number;
  /** The server is up (it starts on the first reply read aloud). */
  running: boolean;
  /** Downloaded voice model ids. */
  installed: string[];
  /** eSpeak-ng is present (Kokoro needs it for most languages). */
  espeak: boolean;
  /** The audiocpp_server binary in use; null when none is bundled. */
  binaryPath: string | null;
  /** The running server's port; null while stopped. */
  port: number | null;
  /** Text-to-speech model families the engine supports. */
  specs: number;
  /** Where downloaded voice models live. */
  modelsDir: string;
}

const FALLBACK: SpeechEngineStatus = {
  version: null, backends: [], backend: 'cpu', threads: 0, cores: 0, running: false, installed: [], espeak: true,
  binaryPath: null, port: null, specs: 0, modelsDir: ''
};

export async function speechEngineStatus(): Promise<SpeechEngineStatus> {
  const status = await invoke<Partial<SpeechEngineStatus>>('voice_models_status').catch(() => null);
  return { ...FALLBACK, ...(status ?? {}) };
}

/** Restart the engine so a backend or thread change applies now. */
export async function restartSpeechEngine(): Promise<void> {
  await invoke('voice_engine_restart').catch(() => {});
}
