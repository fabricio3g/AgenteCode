import type { AppConfig } from '$lib/types/chat';
import { generateTts } from '$lib/services/tts';
import { isTauri } from '$lib/services/tauri';

class TtsStore {
  playing = $state(false);
  currentMessageId = $state<string | null>(null);
  /** Called when TTS playback finishes (used by voice mode to restart listening) */
  onPlaybackEnd: (() => void) | null = null;

  private audioCtx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;

  isSpeaking(messageId: string): boolean {
    return this.playing && this.currentMessageId === messageId;
  }

  stop() {
    try {
      this.currentSource?.stop();
    } catch {
      // already stopped
    }
    this.currentSource = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.playing = false;
    this.currentMessageId = null;
  }

  async speak(messageId: string, text: string, config: AppConfig): Promise<void> {
    // Stop whatever is currently playing
    this.stop();

    if (!text?.trim()) return;

    this.playing = true;
    this.currentMessageId = messageId;

    const engine = config.tts?.engine;
    const useTauri =
      isTauri() &&
      (engine === 'kitten' || engine === 'kokoro') &&
      !!config.tts?.model_path &&
      !!config.tts?.voices_path &&
      !!config.tts?.tokens_path;

    if (useTauri) {
      try {
        const base64Audio = await generateTts({
          text,
          voice: config.tts?.voice || 'af_heart',
          speed: config.tts?.speed ?? 1,
          engine: engine as 'kitten' | 'kokoro',
          model_path: config.tts!.model_path!,
          voices_path: config.tts!.voices_path!,
          tokens_path: config.tts!.tokens_path!,
          lexicon_path: config.tts?.lexicon_path,
          dict_dir: config.tts?.dict_dir,
          data_dir: config.tts?.data_dir
        });

        // Still speaking?
        if (!this.playing || this.currentMessageId !== messageId) return;

        await this.playBase64Pcm(base64Audio, messageId);
      } catch (err) {
        console.warn('[TTS] Tauri TTS failed, falling back to browser:', err);
        if (this.currentMessageId === messageId) {
          try {
            this.playBrowser(messageId, text, config);
          } catch {
            // Both engines failed — ensure state is cleaned up
            this.playing = false;
            this.currentMessageId = null;
            this.onPlaybackEnd?.();
          }
        }
      }
    } else {
      this.playBrowser(messageId, text, config);
    }
  }

  private playBrowser(messageId: string, text: string, config: AppConfig) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.playing = false;
      this.currentMessageId = null;
      this.onPlaybackEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const preferredVoice = config.tts?.voice;
    if (preferredVoice) {
      const voice = window.speechSynthesis.getVoices().find((v) => v.name === preferredVoice);
      if (voice) utterance.voice = voice;
    }
    utterance.rate = Number(config.tts?.speed || 1);
    utterance.onend = () => {
      if (this.currentMessageId === messageId) {
        this.playing = false;
        this.currentMessageId = null;
        this.onPlaybackEnd?.();
      }
    };
    utterance.onerror = () => {
      if (this.currentMessageId === messageId) {
        this.playing = false;
        this.currentMessageId = null;
        this.onPlaybackEnd?.();
      }
    };
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      this.playing = false;
      this.currentMessageId = null;
      this.onPlaybackEnd?.();
    }
  }

  private async playBase64Pcm(base64: string, messageId: string): Promise<void> {
    // Decode base64 → raw bytes
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Backend encodes as Int16 PCM (i16 * 32767.0), little-endian, 24000 Hz mono
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const int16 = new Int16Array(bytes.buffer, 0, sampleCount);

    // Convert Int16 → Float32 normalized to [-1, 1]
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Create/reuse AudioContext
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext({ sampleRate: 24000 });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    const buffer = this.audioCtx.createBuffer(1, sampleCount, 24000);
    buffer.copyToChannel(float32, 0);

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);

    this.currentSource = source;

    source.onended = () => {
      if (this.currentMessageId === messageId) {
        this.playing = false;
        this.currentMessageId = null;
        this.onPlaybackEnd?.();
      }
    };

    source.start();
  }
}

export const ttsStore = new TtsStore();
