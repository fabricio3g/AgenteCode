/** Dictation models (Whisper, MIT), as offered in the mic popover and Settings → Voice. */
import { invoke } from '$lib/services/bridge';

export type SpeechModel = {
  tier: 'fast' | 'balanced' | 'best';
  quality: string;
  recommended: boolean;
  bytes: number;
  installed: boolean;
  inUse: boolean;
  removable: boolean;
};

export const listSpeechModels = () => invoke<SpeechModel[]>('list_speech_models');
export const useSpeechModel = (quality: string) => invoke<SpeechModel[]>('use_speech_model', { quality });
export const removeSpeechModel = (quality: string) => invoke<SpeechModel[]>('remove_speech_model', { quality });
/** Install the engine if needed and download `quality`; progress arrives as `voice-setup-progress`. */
export const setupSpeech = (quality?: string) => invoke('setup_voice', quality ? { quality } : {});
