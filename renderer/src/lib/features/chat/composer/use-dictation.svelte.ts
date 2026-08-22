import { appStore } from '$lib/stores/app.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { ttsStore } from '$lib/stores/tts.svelte';
import { isElectron } from '$lib/services/bridge';
import { sttTranscribe } from '$lib/services/stt';

/**
 * Speech-to-text for the composer.
 *
 * Two paths, picked once at construction: the browser Web Speech API when it is
 * available, and a local Whisper round-trip via MediaRecorder inside Electron —
 * where Web Speech would push audio to Chromium's network endpoint. Both feed
 * the same waveform analyser, and both append to the composer rather than
 * replacing it.
 *
 * This lived inside a 1371-line component alongside drag-and-drop, OCR progress,
 * and a placeholder animation. It is stateful and long-lived, so it is a class
 * rather than a set of functions: the recorder, the audio context, and the
 * recognition instance all need tearing down together.
 */

type RecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal: boolean }>> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionCtor = new () => RecognitionInstance;

/** Relative bar heights for the waveform, normalized to the tallest. */
const WAVE_WEIGHTS = [28, 36, 46, 34, 26, 38, 52, 58, 44, 32, 26, 37, 49, 35, 28].map(
  (height) => height / 58
);

/** Cap a recording so the transcription payload stays small. */
const MAX_RECORDING_MS = 30_000;
/** Anything shorter than this is a mis-click, not speech. */
const MIN_RECORDING_MS = 250;

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function microphoneAccessMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    if (platform === 'win32') {
      return 'Microphone permission is blocked. Enable Windows Settings → Privacy & security → Microphone → Microphone access and Let desktop apps access your microphone.';
    }
    if (platform === 'darwin') {
      return 'Microphone permission is blocked. Enable System Settings → Privacy & Security → Microphone for Electron/Terminal, then restart the app.';
    }
    return 'Microphone permission is blocked. Please allow microphone access and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect a microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Microphone is already in use by another app.';
  }
  return err instanceof Error ? err.message : 'Unable to access microphone.';
}

export type DictationPhase = 'idle' | 'permission' | 'recording' | 'transcribing' | 'error';

export class Dictation {
  /** Web Speech is listening. */
  speechListening = $state(false);
  /** MediaRecorder is capturing for Whisper. */
  whisperListening = $state(false);
  /**
   * Where in the capture cycle we are.
   *
   * This is explicit state because the voice overlay used to infer it by
   * substring-matching the interim transcript for words like "Recording" and
   * "Transcribing" — so the UI silently broke whenever that copy was reworded.
   */
  phase = $state<DictationPhase>('idle');
  /** Partial transcript, shown live under the orb. */
  interim = $state('');
  /** 15 normalized levels driving the waveform bars. */
  audioLevels = $state<number[]>(Array(WAVE_WEIGHTS.length).fill(0));

  private recognition: RecognitionInstance | null = null;
  private recorder: MediaRecorder | null = null;
  private recordedChunks: BlobPart[] = [];
  private micStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserRaf: number | null = null;
  private smoothedLevel = 0;
  private disposed = false;

  readonly hasSpeechRecognition: boolean;
  readonly hasMediaRecorder: boolean;

  constructor() {
    // Inside Electron, always take the local Whisper path.
    this.hasSpeechRecognition =
      !isElectron() && typeof window !== 'undefined' && !!getRecognitionCtor();
    this.hasMediaRecorder =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined';
  }

  get supported(): boolean {
    return this.hasSpeechRecognition || (isElectron() && this.hasMediaRecorder);
  }

  get listening(): boolean {
    return this.speechListening || this.whisperListening;
  }

  /** True while starting up too, so the mic button doesn't look idle. */
  get uiActive(): boolean {
    return this.listening || this.phase !== 'idle';
  }

  /**
   * Start or stop dictation.
   * @param autoSend Send the message as soon as a final transcript lands.
   *                 Used by hands-free voice mode.
   */
  toggle(autoSend = false): void {
    if (!this.supported) {
      toastStore.error('Microphone recording is not available in this environment.');
      return;
    }
    if (isElectron()) {
      void this.toggleWhisper(autoSend);
      return;
    }
    this.toggleSpeech(autoSend);
  }

  stop(): void {
    if (this.speechListening && this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.whisperListening && this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.speechListening = false;
    this.whisperListening = false;
    this.phase = 'idle';
    this.interim = '';
    this.stopAnalyser();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  // ── Web Speech ────────────────────────────────────────────────────────────

  private toggleSpeech(autoSend: boolean): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    if (this.speechListening) {
      this.recognition?.stop();
      return;
    }

    ttsStore.stop();

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* noop */
      }
      this.recognition = null;
    }

    this.phase = 'permission';

    // Prime the preferred device first: Chrome hands SpeechRecognition whichever
    // audio input was most recently activated, not the one we configured.
    void navigator.mediaDevices
      .getUserMedia(this.audioConstraints())
      .then((stream) => {
        this.micStream = stream;
        this.startAnalyser(stream);
      })
      .catch(() => {
        /* denied or unavailable — recognition may still work */
      })
      .finally(() => {
        if (this.disposed) return;
        const recognition = new Ctor();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        this.recognition = recognition;
        this.speechListening = true;
        this.phase = 'recording';
        this.interim = '';
        this.attachRecognitionHandlers(autoSend);
        try {
          recognition.start();
        } catch {
          /* already started */
        }
      });
  }

  private attachRecognitionHandlers(autoSend: boolean): void {
    const recognition = this.recognition;
    if (!recognition) return;

    recognition.onresult = (event) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result[0]) continue;
        if ((result as unknown as { isFinal: boolean }).isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      this.interim = interim;
      if (final.trim()) this.appendToComposer(final);
    };

    const finish = () => {
      this.speechListening = false;
      this.phase = 'idle';
      this.interim = '';
      this.stopAnalyser();
    };

    recognition.onerror = () => {
      this.speechListening = false;
      this.phase = 'error';
      this.interim = '';
      this.stopAnalyser();
    };
    recognition.onend = () => {
      finish();
      if (autoSend) this.maybeAutoSend();
    };
  }

  // ── Whisper via MediaRecorder ─────────────────────────────────────────────

  private async toggleWhisper(autoSend: boolean): Promise<void> {
    if (this.whisperListening) {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      this.stopAnalyser();
      return;
    }

    if (!this.hasMediaRecorder) {
      toastStore.error('Microphone recording is not available in this environment.');
      return;
    }

    ttsStore.stop();
    this.phase = 'permission';
    this.interim = '';
    this.recordedChunks = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia(this.audioConstraints());
      this.whisperListening = true;
      this.phase = 'recording';
      this.micStream = stream;
      this.startAnalyser(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const startedAt = Date.now();
      this.recorder = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.recordedChunks.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        this.whisperListening = false;
        this.phase = 'transcribing';
        this.stopAnalyser();

        try {
          const blob = new Blob(this.recordedChunks, { type: mimeType });
          if (!blob.size || Date.now() - startedAt < MIN_RECORDING_MS) {
            this.phase = 'idle';
            toastStore.warning('Recording too short. Please speak a bit longer.');
            return;
          }

          const bytes = new Uint8Array(await blob.arrayBuffer());
          const result = await sttTranscribe(bytes as never, mimeType.split(';')[0]);
          this.phase = 'idle';
          this.interim = '';

          if (!result.text?.trim()) {
            toastStore.info('No speech detected. Try speaking closer to the microphone.');
            return;
          }
          this.appendToComposer(result.text);
          if (autoSend) this.maybeAutoSend();
        } catch (err) {
          this.phase = 'error';
          this.interim = '';
          toastStore.error(
            err instanceof Error ? err.message : 'Transcription failed. Please try again.'
          );
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        this.whisperListening = false;
        this.phase = 'error';
        this.interim = '';
        this.stopAnalyser();
        toastStore.error('Microphone recording failed. Please check device permissions.');
      };

      recorder.start(200);
      setTimeout(() => {
        if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      }, MAX_RECORDING_MS);
    } catch (err) {
      this.whisperListening = false;
      this.phase = 'error';
      this.interim = '';
      this.stopAnalyser();
      toastStore.error(microphoneAccessMessage(err));
    }
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  private audioConstraints(): MediaStreamConstraints {
    const deviceId = appStore.config.stt?.audio_input_device_id;
    return deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
  }

  private appendToComposer(text: string): void {
    const addition = text.trim();
    if (!addition) return;
    const current = appStore.composer.trim();
    appStore.updateComposer(current ? `${current} ${addition}` : addition);
  }

  private maybeAutoSend(): void {
    if (this.disposed) return;
    if (!appStore.composer.trim()) return;
    if (appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun) return;
    void appStore.sendCurrentMessage();
  }

  /**
   * Drive the waveform from mic input. Bars never fall to zero — an idle sine
   * keeps them breathing so the control reads as live rather than broken.
   */
  private startAnalyser(stream: MediaStream): void {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      context.createMediaStreamSource(stream).connect(analyser);

      this.audioContext = context;
      this.analyser = analyser;

      const samples = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(samples);

        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
          const deviation = (samples[i] - 128) / 128;
          sumSquares += deviation * deviation;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        this.smoothedLevel = Math.min(1, this.smoothedLevel * 0.75 + rms * 4);

        const now = Date.now() / 1000;
        this.audioLevels = WAVE_WEIGHTS.map((weight, index) => {
          const idle = 0.12 + Math.sin(now * 1.8 + index * 0.7) * 0.06;
          return Math.max(idle, this.smoothedLevel * weight);
        });

        this.analyserRaf = requestAnimationFrame(tick);
      };
      this.analyserRaf = requestAnimationFrame(tick);
    } catch {
      /* Web Audio unavailable — the waveform simply stays flat */
    }
  }

  private stopAnalyser(): void {
    if (this.analyserRaf !== null) {
      cancelAnimationFrame(this.analyserRaf);
      this.analyserRaf = null;
    }
    this.analyser?.disconnect();
    this.analyser = null;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.smoothedLevel = 0;
    this.audioLevels = Array(WAVE_WEIGHTS.length).fill(0);
  }
}
