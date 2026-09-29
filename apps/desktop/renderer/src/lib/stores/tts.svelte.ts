import type { AppConfig } from '$lib/types/chat';
import { VOICE_MODELS } from '$shared/voice-models';
import { generateTtsStream, cancelTtsStream, base64ToFloat32Pcm, onTtsChunk, onTtsDone, onTtsStart } from '$lib/services/tts';
import { invoke } from '$lib/services/bridge';
import { cleanTextForTTS } from '$lib/utils/tts-text';

const SAMPLE_RATE = 24000;

type TtsChunkEvent = { seq?: number; index?: number; total?: number; base64?: string };
type TtsStartEvent = { seq?: number; total?: number };
type TtsDoneEvent = { seq?: number };

class TtsStore {
  playing = $state(false);
  isGenerating = $state(false);
  currentMessageId = $state<string | null>(null);
  onPlaybackEnd: (() => void) | null = null;
  preloaded = $state(false);
  preloadPromise: Promise<boolean> | null = null;
  progress: { index: number; total: number } | null = $state(null);
  lastPlayedMessageId: string | null = $state(null);
  elapsedTime = $state(0);
  totalDuration = $state(0);
  audioBuffers: Map<string, Float32Array> = new Map();
  // Reactive set of message IDs that have stored audio (for Svelte reactivity)
  storedAudioIds = $state<Set<string>>(new Set());
  // Fires when a generation + playback session completes for a message
  onAudioComplete: ((messageId: string, duration: number) => void) | null = null;

  private audioCtx: AudioContext | null = null;
  private genId = 0;
  private currentGenId: number | null = null;
  private chunkQueue: { index: number; samples: Float32Array }[] = [];
  private nextIndex = 0;
  private doneReceived = false;
  private unsubChunk: (() => void) | null = null;
  private unsubDone: (() => void) | null = null;
  private unsubStart: (() => void) | null = null;
  private collectedChunks: { index: number; samples: Float32Array }[] = [];
  private progressInterval: ReturnType<typeof setInterval> | null = null;
  // Look-ahead scheduling state
  private scheduleAheadTime = 0.1; // seconds to keep buffered ahead
  private scheduledCount = 0; // chunks already scheduled for playback
  private lastScheduledEnd = 0; // AudioContext time when last scheduled chunk ends
  private pendingEndSource: AudioBufferSourceNode | null = null; // tracks final chunk for onended
  private silenceBuffer: AudioBuffer | null = null; // 200ms silence between sentences

  async preloadEngine(): Promise<boolean> {
    if (this.preloaded) return true;
    if (this.preloadPromise) return this.preloadPromise;
    this.preloadPromise = (async () => {
      try {
        // Always call preload_tts to ensure worker is initialized.
        // list_tts_voices may return cached voices without initWorker()
        // having completed, so we unconditionally warm up the worker.
        await invoke<string[]>('preload_tts');
        this.preloaded = true;
        return true;
      } catch { return false; }
    })();
    return this.preloadPromise;
  }

  isSpeaking(messageId: string): boolean {
    return this.playing && this.currentMessageId === messageId;
  }

  private playbackStartTime = 0; // AudioContext.currentTime when first chunk started playing

  private startProgressTracking() {
    this.stopProgressTracking();
    this.playbackStartTime = this.audioCtx ? this.audioCtx.currentTime : 0;
    this.progressInterval = setInterval(() => {
      if (this.audioCtx && this.audioCtx.state === 'running' && this.playing) {
        this.elapsedTime = Math.max(0, this.audioCtx.currentTime - this.playbackStartTime);
      }
    }, 50);
  }

  private stopProgressTracking() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  stop() {
    cancelTtsStream();
    this.stopProgressTracking();
    this.currentGenId = null;
    this.chunkQueue = [];
    this.collectedChunks = [];
    this.nextIndex = 0;
    this.doneReceived = false;
    this.scheduledCount = 0;
    this.lastScheduledEnd = 0;
    this.pendingEndSource = null;
    this.silenceBuffer = null;
    this.playbackStartTime = 0;
    this.unsubChunk?.();
    this.unsubDone?.();
    this.unsubStart?.();
    this.unsubChunk = null;
    this.unsubDone = null;
    this.unsubStart = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.playing = false;
    this.isGenerating = false;
    this.currentMessageId = null;
    this.progress = null;
    this.elapsedTime = 0;
    this.totalDuration = 0;
  }

  async speak(messageId: string, text: string, config: AppConfig): Promise<void> {
    // If we already have a stored buffer for this message, replay instead of re-generating
    if (this.audioBuffers.has(messageId)) {
      return this.replay(messageId);
    }

    this.stop();
    const cleaned = cleanTextForTTS(text);
    if (!cleaned?.trim()) return;

    this.lastPlayedMessageId = messageId;
    this.playing = true;
    this.isGenerating = true;
    this.currentMessageId = messageId;
    this.elapsedTime = 0;
    this.totalDuration = 0;
    this.collectedChunks = [];

    const voice = config.tts?.voice || 'af_heart';
    const speed = config.tts?.speed ?? 1;
    const volume = config.tts?.volume ?? 1;

    // A voice of the local engines (Settings → Voice); anything else is the browser's.
    if (VOICE_MODELS.some((model) => model.voices.some((option) => option.id === voice))) {
      this.genId++;
      this.currentGenId = this.genId;
      this.chunkQueue = [];
      this.nextIndex = 0;
      this.doneReceived = false;
      this.scheduledCount = 0;
      this.lastScheduledEnd = 0;
      this.pendingEndSource = null;

      this.unsubChunk = onTtsChunk((evt) => {
        const chunk = evt as TtsChunkEvent;
        if (chunk.seq !== this.currentGenId || this.currentMessageId !== messageId) return;
        const index = Number(chunk.index ?? 0);
        const total = Number(chunk.total ?? 0);
        const base64 = String(chunk.base64 || '');
        if (!base64) return;
        this.progress = { index: index + 1, total };
        const samples = base64ToFloat32Pcm(base64);
        this.collectedChunks.push({ index, samples });
        this.chunkQueue.push({ index, samples });
        this.chunkQueue.sort((a, b) => a.index - b.index);
        this.scheduleAhead();
      });

      this.unsubStart = onTtsStart((evt) => {
        const start = evt as TtsStartEvent;
        if (start.seq !== this.currentGenId) return;
        this.progress = { index: 0, total: Number(start.total ?? 0) };
      });

      this.unsubDone = onTtsDone((evt) => {
        const done = evt as TtsDoneEvent;
        if (done.seq !== this.currentGenId) return;
        this.doneReceived = true;
        // If all chunks already scheduled, set up end detection immediately
        if (this.scheduledCount >= this.chunkQueue.length) {
          this.setupEndDetection();
        } else {
          // Otherwise scheduleAhead will catch it on next chunk
          this.scheduleAhead();
        }
      });

      this.startProgressTracking();
      generateTtsStream({
        text: cleaned,
        voice,
        speed,
        volume,
        model: config.tts?.voice_model,
        language: config.tts?.language
      });
      return;
    }

    this.playBrowser(messageId, cleaned, config);
  }

  private ensureSilenceBuffer() {
    if (!this.audioCtx || this.silenceBuffer) return;
    // Create 200ms silence buffer for natural rhythm between sentences
    const silenceLen = Math.round(24000 * 200 / 1000);
    this.silenceBuffer = this.audioCtx.createBuffer(1, silenceLen, 24000);
  }

  private ensureAudioContext() {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  private scheduleAhead() {
    if (this.currentMessageId === null) return;
    if (this.scheduledCount >= this.chunkQueue.length) return; // nothing new to schedule

    this.ensureAudioContext();
    if (!this.audioCtx) return;

    this.ensureSilenceBuffer();

    // Schedule chunks in look-ahead window
    while (this.scheduledCount < this.chunkQueue.length) {
      const chunk = this.chunkQueue[this.scheduledCount];
      if (!chunk) break;

      const buffer = this.audioCtx.createBuffer(1, chunk.samples.length, SAMPLE_RATE);
      buffer.copyToChannel(chunk.samples as Float32Array<ArrayBuffer>, 0);

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);

      // Schedule to start at the later of: current time + small margin, or lastScheduledEnd
      const when = Math.max(this.audioCtx.currentTime + 0.02, this.lastScheduledEnd);
      source.start(when);

      this.lastScheduledEnd = when + buffer.duration;
      this.scheduledCount++;
      this.nextIndex = this.scheduledCount;

      // If there's a next chunk, schedule 200ms silence gap
      if (this.scheduledCount < this.chunkQueue.length && this.silenceBuffer) {
        const silenceSrc = this.audioCtx.createBufferSource();
        silenceSrc.buffer = this.silenceBuffer;
        silenceSrc.connect(this.audioCtx.destination);
        silenceSrc.start(this.lastScheduledEnd);
        this.lastScheduledEnd += this.silenceBuffer.duration;
      }

      // Track the final source for end detection
      this.pendingEndSource = source;
    }

    // If done and all chunks scheduled, set up end detection
    if (this.doneReceived && this.scheduledCount >= this.chunkQueue.length) {
      this.setupEndDetection();
    }
  }

  private setupEndDetection() {
    if (this.pendingEndSource && this.audioCtx) {
      const endTime = this.lastScheduledEnd;
      const source = this.pendingEndSource;
      source.onended = () => {
        this.onPlaybackEnded();
      };
      // Fallback timeout in case onended doesn't fire
      const waitMs = Math.max(100, (endTime - this.audioCtx.currentTime + 0.1) * 1000);
      setTimeout(() => {
        this.onPlaybackEnded();
      }, waitMs);
    } else {
      this.onPlaybackEnded();
    }
  }

  private onPlaybackEnded() {
    this.stopProgressTracking();
    // Store collected chunks as a single buffer BEFORE clearing state
    if (this.currentMessageId && this.collectedChunks.length > 0 && !this.audioBuffers.has(this.currentMessageId)) {
      this.storeCollectedAudio(this.currentMessageId);
    }
    const finishedId = this.currentMessageId;
    const totalDur = this.totalDuration;
    this.isGenerating = false;
    this.playing = false;
    this.progress = null;
    this.elapsedTime = this.totalDuration;
    this.pendingEndSource = null;
    this.currentMessageId = null;
    this.unsubChunk?.();
    this.unsubDone?.();
    this.unsubStart?.();
    this.unsubChunk = null;
    this.unsubDone = null;
    this.unsubStart = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.onPlaybackEnd?.();
    // Fire onAudioComplete AFTER buffer is stored so the player can transition
    this.onAudioComplete?.(finishedId!, totalDur);
  }

  private storeCollectedAudio(messageId: string) {
    if (this.collectedChunks.length === 0) return;
    const sorted = [...this.collectedChunks].sort((a, b) => a.index - b.index);
    let totalLen = 0;
    for (const c of sorted) totalLen += c.samples.length;
    const combined = new Float32Array(totalLen);
    let offset = 0;
    for (const c of sorted) {
      combined.set(c.samples, offset);
      offset += c.samples.length;
    }
    this.audioBuffers.set(messageId, combined);
    this.totalDuration = combined.length / SAMPLE_RATE;
    // Mark as stored for Svelte reactivity
    this.storedAudioIds = new Set(this.storedAudioIds).add(messageId);
  }

  hasStoredAudio(messageId: string): boolean {
    return this.storedAudioIds.has(messageId);
  }

  async replay(messageId: string): Promise<void> {
    const buffer = this.audioBuffers.get(messageId);
    if (!buffer) return;

    this.stop();
    this.lastPlayedMessageId = messageId;
    this.playing = true;
    this.currentMessageId = messageId;
    this.elapsedTime = 0;
    this.totalDuration = buffer.length / SAMPLE_RATE;

    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.startProgressTracking();

    const audioBuffer = this.audioCtx.createBuffer(1, buffer.length, SAMPLE_RATE);
    audioBuffer.copyToChannel(buffer as Float32Array<ArrayBuffer>, 0);
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    const startTime = this.audioCtx.currentTime;
    source.onended = () => {
      this.stopProgressTracking();
      this.playing = false;
      this.currentMessageId = null;
      this.elapsedTime = this.totalDuration;
      this.onPlaybackEnd?.();
    };
    source.start();

    // Track progress via audio clock
    this.progressInterval = setInterval(() => {
      if (this.audioCtx && this.audioCtx.state === 'running' && this.playing) {
        const pos = this.audioCtx.currentTime - startTime;
        // Account for playback rate (default 1.0) adjusted by config speed
        const rate = source.playbackRate?.value ?? 1;
        this.elapsedTime = Math.min(pos * rate, this.totalDuration);
      }
    }, 50);
  }

  async seek(messageId: string, fraction: number) {
    const buffer = this.audioBuffers.get(messageId);
    if (!buffer) return;

    const sampleOffset = Math.floor(fraction * buffer.length);
    const sliced = buffer.slice(sampleOffset);

    this.stop();
    this.lastPlayedMessageId = messageId;
    this.playing = true;
    this.currentMessageId = messageId;
    this.elapsedTime = 0;
    this.totalDuration = buffer.length / SAMPLE_RATE;

    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    const audioBuffer = this.audioCtx.createBuffer(1, sliced.length, SAMPLE_RATE);
    audioBuffer.copyToChannel(sliced as Float32Array<ArrayBuffer>, 0);
    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    const startTime = this.audioCtx.currentTime;
    const baseElapsed = (sampleOffset / SAMPLE_RATE);
    this.elapsedTime = baseElapsed;

    source.onended = () => {
      this.stopProgressTracking();
      this.playing = false;
      this.currentMessageId = null;
      this.elapsedTime = this.totalDuration;
      this.onPlaybackEnd?.();
    };
    source.start();

    this.progressInterval = setInterval(() => {
      if (this.audioCtx && this.audioCtx.state === 'running' && this.playing) {
        const pos = this.audioCtx.currentTime - startTime;
        this.elapsedTime = baseElapsed + pos;
      }
    }, 50);
  }

  private playBrowser(messageId: string, text: string, config: AppConfig) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.playing = false; this.currentMessageId = null; this.isGenerating = false; this.onPlaybackEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Number(config.tts?.speed || 1);
    u.onend = () => { if (this.currentMessageId === messageId) { this.playing = false; this.currentMessageId = null; this.isGenerating = false; this.onPlaybackEnd?.(); } };
    u.onerror = () => { if (this.currentMessageId === messageId) { this.playing = false; this.currentMessageId = null; this.isGenerating = false; this.onPlaybackEnd?.(); } };
    try { window.speechSynthesis.speak(u); } catch {
      this.playing = false; this.currentMessageId = null; this.isGenerating = false;
    }
  }
}

export const ttsStore = new TtsStore();
