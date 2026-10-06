import type { AppConfig } from '$lib/types/chat';
import { VOICE_MODELS } from '$shared/voice-models';
import { generateTtsStream, cancelTtsStream, base64ToFloat32Pcm, onTtsChunk, onTtsDone, onTtsStart, onTtsError } from '$lib/services/tts';
import { toastStore } from '$lib/stores/toast.svelte';
import { invoke } from '$lib/services/bridge';
import { cleanTextForTTS } from '$lib/utils/tts-text';

const SAMPLE_RATE = 24000;

type TtsChunkEvent = { requestId?: string; index?: number; total?: number; base64?: string };
type TtsStartEvent = { requestId?: string; total?: number };
type TtsDoneEvent = { requestId?: string };

type SpeechPart = { id: string; text: string; config: AppConfig };
function speechSignature(text: string, config: AppConfig): string {
  return JSON.stringify([speechRequest(text, config, ''), config.tts?.providers?.[config.tts.api_provider ?? '']?.base_url]);
}
function engineSpeech(config: AppConfig): boolean {
  const tts = config.tts;
  return tts?.backend_mode === 'api' || (tts?.backend_mode !== 'browser' &&
    (tts?.backend_mode === 'local' || VOICE_MODELS.some(model => model.voices.some(voice => voice.id === (tts?.voice || 'af_heart')))));
}
function speechRequest(text: string, config: AppConfig, requestId: string) {
  const tts = config.tts;
  const clone = tts?.backend_mode === 'api' ? undefined : tts?.cloned_voices?.find((voice) => voice.id === tts.cloned_voice);
  return { text: cleanTextForTTS(text), requestId, ...(clone ? { voiceRef: { file: clone.file, transcript: clone.transcript } } : {}), voice: tts?.backend_mode === 'api' ? tts.voice || tts.providers?.[tts.api_provider ?? '']?.voice || '' : tts?.voice || 'af_heart',
    speed: tts?.speed ?? 1, volume: tts?.volume ?? 1, backend: tts?.backend_mode, provider: tts?.api_provider,
    model: tts?.backend_mode === 'api' ? tts.providers?.[tts.api_provider ?? '']?.model : tts?.voice_model, language: tts?.language };
}

class TtsStore {
  playing = $state(false);
  /** Audio was scheduled or the browser reported playback, not just synthesis requested. */
  audioStarted = $state(false);
  paused = $state(false);
  isGenerating = $state(false);
  currentMessageId = $state<string | null>(null);
  onPlaybackEnd: (() => void) | null = null;
  preloaded = $state(false);
  preloadPromise: Promise<boolean> | null = null;
  progress: { index: number; total: number } | null = $state(null);
  lastPlayedMessageId: string | null = $state(null);
  elapsedTime = $state(0);
  totalDuration = $state(0);
  lastError = $state<string | null>(null);
  audioBuffers: Map<string, Float32Array> = new Map();
  private audioSignatures = new Map<string, string>();
  private queue: Array<{ id: string; text: string; config: AppConfig }> = [];
  private queueing = false;
  private queueEpoch = 0;
  private prefetch: { id: string; promise: Promise<void>; cancel: () => void } | null = null;

  speakSequence(parts: Array<{ id: string; text: string; config: AppConfig }>) {
    this.stop();
    this.queue = parts.filter((part) => part.text.trim());
    this.nextInSequence();
  }

  /** Add streaming call sentences without stopping speech already in progress. */
  enqueueSpeech(parts: Array<{ id: string; text: string; config: AppConfig }>) {
    this.queue.push(...parts.filter(part => part.text.trim()));
    if (!this.playing && !this.isGenerating && !this.paused) this.nextInSequence();
    else if (this.playing && !this.isGenerating) this.prefetchNext();
  }

  forgetAudio(ids: string[]) {
    for (const id of ids) { this.audioBuffers.delete(id); this.audioSignatures.delete(id); }
    this.storedAudioIds = new Set([...this.storedAudioIds].filter(id => !ids.includes(id)));
  }

  private nextInSequence() {
    const next = this.queue.shift();
    if (!next) return;
    const epoch = this.queueEpoch;
    const warm = this.prefetch?.id === next.id ? this.prefetch : null;
    const play = () => {
      if (epoch !== this.queueEpoch) return;
      if (warm && this.prefetch === warm) this.prefetch = null;
      this.queueing = true;
      void this.speak(next.id, next.text, next.config);
      this.queueing = false;
    };
    if (warm) { this.isGenerating = true; void warm.promise.then(play); } else play();
  }

  /** Prepare one following clip while the audio clock plays the current one. */
  private prefetchNext() {
    const next = this.queue[0];
    if (!next || next.id === this.currentMessageId || this.prefetch || !engineSpeech(next.config)) return;
    const epoch = this.queueEpoch;
    const requestId = crypto.randomUUID();
    const chunks = new Map<number, Float32Array>();
    let expected = 0;
    const unsubs: Array<() => void> = [];
    let finish!: () => void;
    let settled = false;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    const cleanup = () => { if (settled) return; settled = true; unsubs.forEach(unsub => unsub()); finish(); };
    this.prefetch = { id: next.id, promise, cancel: cleanup };
    unsubs.push(onTtsChunk(event => {
      const chunk = event as TtsChunkEvent;
      if (epoch !== this.queueEpoch || chunk.requestId !== requestId) return;
      expected = Number(chunk.total ?? expected);
      chunks.set(Number(chunk.index ?? 0), base64ToFloat32Pcm(String(chunk.base64 ?? '')));
    }));
    unsubs.push(onTtsDone(event => {
      if ((event as TtsDoneEvent).requestId !== requestId) return;
      expected = Number(event.total ?? expected);
      if (epoch === this.queueEpoch && chunks.size) {
        const ordered = [...chunks.entries()].sort((a,b) => a[0]-b[0]);
        if ((!expected || ordered.length === expected) && ordered.every(([index], position) => index === position)) {
          const samples = new Float32Array(ordered.reduce((length, [,chunk]) => length + chunk.length, 0));
          let offset = 0; for (const [,chunk] of ordered) { samples.set(chunk, offset); offset += chunk.length; }
          this.audioBuffers.set(next.id, samples); this.audioSignatures.set(next.id, speechSignature(next.text, next.config));
          this.storedAudioIds = new Set(this.storedAudioIds).add(next.id);
        }
      }
      cleanup();
    }));
    unsubs.push(onTtsError(event => { if (event.requestId === requestId) cleanup(); }));
    void generateTtsStream(speechRequest(next.text, next.config, requestId)).catch(cleanup);
  }
  // Reactive set of message IDs that have stored audio (for Svelte reactivity)
  storedAudioIds = $state<Set<string>>(new Set());
  // Fires when a generation + playback session completes for a message
  onAudioComplete: ((messageId: string, duration: number) => void) | null = null;

  private audioCtx: AudioContext | null = null;
  private genId = 0;
  private currentRequestId: string | null = null;
  private chunkQueue: { index: number; samples: Float32Array }[] = [];
  private doneReceived = false;
  private unsubChunk: (() => void) | null = null;
  private unsubDone: (() => void) | null = null;
  private unsubStart: (() => void) | null = null;
  private unsubError: (() => void) | null = null;
  private collectedChunks: { index: number; samples: Float32Array }[] = [];
  private progressInterval: ReturnType<typeof setInterval> | null = null;
  // Look-ahead scheduling state
  private scheduledCount = 0; // chunks already scheduled for playback
  private lastScheduledEnd = 0; // AudioContext time when last scheduled chunk ends
  private pendingEndSource: AudioBufferSourceNode | null = null; // tracks final chunk for onended
  private playbackTimeline: Array<{ start: number; duration: number; offset: number }> = [];
  private scheduledDuration = 0;

  async preloadEngine(): Promise<boolean> {
    if (this.preloaded) return true;
    if (this.preloadPromise) return this.preloadPromise;
    this.preloadPromise = (async () => {
      try {
        await invoke<string[]>('preload_tts');
        this.preloaded = true;
        return true;
      } catch { return false; }
      finally { this.preloadPromise = null; }
    })();
    return this.preloadPromise;
  }

  isSpeaking(messageId: string): boolean {
    return this.playing && this.currentMessageId === messageId;
  }

  private startProgressTracking() {
    this.stopProgressTracking();
    this.progressInterval = setInterval(() => {
      if (this.audioCtx && this.audioCtx.state === 'running' && this.playing) {
        const now = this.audioCtx.currentTime;
        const clip = [...this.playbackTimeline].reverse().find((item) => item.start <= now);
        if (clip && clip.start <= now) {
          this.elapsedTime = Math.min(this.totalDuration, clip.offset + Math.min(clip.duration, now - clip.start));
        }
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
    if (!this.queueing) { this.queue = []; this.queueEpoch++; this.prefetch?.cancel(); this.prefetch = null; }
    this.genId++;
    cancelTtsStream();
    this.stopProgressTracking();
    this.currentRequestId = null;
    this.chunkQueue = [];
    this.collectedChunks = [];
    this.doneReceived = false;
    this.scheduledCount = 0;
    this.lastScheduledEnd = 0;
    this.pendingEndSource = null;
    this.playbackTimeline = [];
    this.scheduledDuration = 0;
    this.releaseStream();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.audioStarted = false;
    this.playing = false;
    this.paused = false;
    this.isGenerating = false;
    this.currentMessageId = null;
    this.progress = null;
    this.elapsedTime = 0;
    this.totalDuration = 0;
  }

  async pause() {
    if (!this.playing || !this.currentMessageId) return;
    const session = this.genId;
    if (this.audioCtx?.state === 'running') await this.audioCtx.suspend();
    else if (typeof window !== 'undefined') window.speechSynthesis?.pause();
    if (session !== this.genId || !this.currentMessageId) return;
    this.audioStarted = false;
    this.playing = false;
    this.paused = true;
  }

  async resume() {
    if (!this.paused || !this.currentMessageId) return;
    const session = this.genId;
    if (this.audioCtx?.state === 'suspended') await this.audioCtx.resume();
    else if (typeof window !== 'undefined') window.speechSynthesis?.resume();
    if (session !== this.genId || !this.currentMessageId) return;
    this.paused = false;
    this.playing = true;
  }

  async speak(messageId: string, text: string, config: AppConfig): Promise<void> {
    const signature = speechSignature(text, config);
    if (this.audioSignatures.get(messageId) !== signature) {
      this.audioBuffers.delete(messageId);
      this.storedAudioIds = new Set([...this.storedAudioIds].filter((id) => id !== messageId));
      this.audioSignatures.set(messageId, signature);
    }
    // If we already have a stored buffer for this message, replay instead of re-generating
    if (this.audioBuffers.has(messageId)) {
      return this.replay(messageId);
    }

    this.stop();
    this.lastError = null;
    const cleaned = cleanTextForTTS(text);
    if (!cleaned?.trim()) return;

    this.lastPlayedMessageId = messageId;
    this.playing = true;
    this.isGenerating = true;
    this.currentMessageId = messageId;
    this.elapsedTime = 0;
    this.totalDuration = 0;
    this.collectedChunks = [];


    // A voice of the local engines (Settings → Voice); anything else is the browser's.
    if (engineSpeech(config)) {
      const session = this.genId;
      const requestId = crypto.randomUUID();
      this.currentRequestId = requestId;
      this.chunkQueue = [];
      this.doneReceived = false;
      this.scheduledCount = 0;
      this.lastScheduledEnd = 0;
      this.pendingEndSource = null;

      this.unsubChunk = onTtsChunk((evt) => {
        const chunk = evt as TtsChunkEvent;
        if (chunk.requestId !== this.currentRequestId || this.currentMessageId !== messageId) return;
        const index = Number(chunk.index ?? 0);
        const total = Number(chunk.total ?? 0);
        const base64 = String(chunk.base64 || '');
        if (!base64) return;
        this.progress = { index: index + 1, total };
        let samples: Float32Array;
        try { samples = base64ToFloat32Pcm(base64); }
        catch { this.failPlayback('The voice engine returned invalid audio.'); return; }
        if (!samples.length || this.collectedChunks.some((item) => item.index === index)) return;
        this.collectedChunks.push({ index, samples });
        this.chunkQueue.push({ index, samples });
        this.chunkQueue.sort((a, b) => a.index - b.index);
        this.totalDuration += samples.length / SAMPLE_RATE;
        this.scheduleAhead();
      });

      this.unsubStart = onTtsStart((evt) => {
        const start = evt as TtsStartEvent;
        if (start.requestId !== this.currentRequestId) return;
        this.progress = { index: 0, total: Number(start.total ?? 0) };
      });

      this.unsubDone = onTtsDone((evt) => {
        const done = evt as TtsDoneEvent;
        if (done.requestId !== this.currentRequestId) return;
        this.doneReceived = true;
        this.isGenerating = false;
        this.scheduleAhead();
        if (!this.pendingEndSource) this.onPlaybackEnded();
        else this.prefetchNext();
      });

      this.unsubError = onTtsError((event) => {
        if (event.requestId !== this.currentRequestId) return;
        this.failPlayback(String(event.message || 'Voice generation failed.'));
      });

      try {
        // Unlock the audio clock from the user's Play click, before synthesis
        // waits for the engine. Creating it on a later IPC chunk can be blocked.
        await this.ensureAudioContext();
        if (session !== this.genId) return;
        this.startProgressTracking();
        await generateTtsStream(speechRequest(cleaned, config, requestId));
      } catch (error) {
        if (session === this.genId) this.failPlayback(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    this.playBrowser(messageId, cleaned, config);
  }

  private failPlayback(message: string) {
    this.stop();
    this.lastError = message;
    toastStore.error(message);
    this.onPlaybackEnd?.();
  }

  private async ensureAudioContext() {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  private scheduleAhead() {
    if (this.currentMessageId === null) return;
    if (this.scheduledCount >= this.chunkQueue.length) return; // nothing new to schedule

    if (!this.audioCtx) return;
    const session = this.genId;

    // Schedule chunks in look-ahead window
    while (this.scheduledCount < this.chunkQueue.length) {
      const chunk = this.chunkQueue[this.scheduledCount];
      if (!chunk || chunk.index !== this.scheduledCount) break;

      const buffer = this.audioCtx.createBuffer(1, chunk.samples.length, SAMPLE_RATE);
      buffer.copyToChannel(chunk.samples as Float32Array<ArrayBuffer>, 0);

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);
      source.onended = () => {
        if (session !== this.genId || this.pendingEndSource !== source) return;
        this.pendingEndSource = null;
        if (this.doneReceived && this.scheduledCount === this.chunkQueue.length) this.onPlaybackEnded();
      };

      // Schedule to start at the later of: current time + small margin, or lastScheduledEnd
      const when = Math.max(this.audioCtx.currentTime + 0.02, this.lastScheduledEnd);
      source.start(when);
      this.audioStarted = true;
      this.playbackTimeline.push({ start: when, duration: buffer.duration, offset: this.scheduledDuration });
      this.scheduledDuration += buffer.duration;

      this.lastScheduledEnd = when + buffer.duration;
      this.scheduledCount++;

      // Track the final source for end detection
      this.pendingEndSource = source;
    }

  }

  /** Drop the stream listeners and close the audio context. */
  private releaseStream() {
    for (const unsub of [this.unsubChunk, this.unsubDone, this.unsubStart, this.unsubError]) unsub?.();
    this.unsubChunk = this.unsubDone = this.unsubStart = this.unsubError = null;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  private onPlaybackEnded() {
    if ((!this.playing && !this.paused) || !this.currentMessageId) return;
    this.stopProgressTracking();
    // Store collected chunks as a single buffer BEFORE clearing state
    if (this.currentMessageId && this.collectedChunks.length > 0 && !this.audioBuffers.has(this.currentMessageId)) {
      this.storeCollectedAudio(this.currentMessageId);
    }
    const finishedId = this.currentMessageId;
    const totalDur = this.totalDuration;
    this.isGenerating = false;
    this.audioStarted = false;
    this.playing = false;
    this.paused = false;
    this.progress = null;
    this.elapsedTime = this.totalDuration;
    this.pendingEndSource = null;
    this.currentMessageId = null;
    this.currentRequestId = null;
    this.releaseStream();
    if (this.queue.length) this.nextInSequence();
    else this.onPlaybackEnd?.();
    // Fire onAudioComplete AFTER buffer is stored so the player can transition
    if (this.audioBuffers.has(finishedId)) this.onAudioComplete?.(finishedId, totalDur);
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
    await this.playStoredAudio(messageId, 0);
  }

  async seek(messageId: string, fraction: number) {
    await this.playStoredAudio(messageId, Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0);
  }

  private async playStoredAudio(messageId: string, fraction: number): Promise<void> {
    const buffer = this.audioBuffers.get(messageId);
    if (!buffer?.length) return;

    const sampleOffset = Math.floor(fraction * buffer.length);
    const sliced = buffer.slice(sampleOffset);

    this.stop();
    this.lastError = null;
    const session = this.genId;
    this.lastPlayedMessageId = messageId;
    this.playing = true;
    this.currentMessageId = messageId;
    this.elapsedTime = sampleOffset / SAMPLE_RATE;
    this.totalDuration = buffer.length / SAMPLE_RATE;

    try {
      await this.ensureAudioContext();
      if (session !== this.genId) return;
      if (!sliced.length) { this.finishStoredPlayback(); return; }
      const ctx = this.audioCtx!;
      const audioBuffer = ctx.createBuffer(1, sliced.length, SAMPLE_RATE);
      audioBuffer.copyToChannel(sliced, 0);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => { if (session === this.genId) this.finishStoredPlayback(); };
      this.playbackTimeline.push({ start: ctx.currentTime, duration: audioBuffer.duration, offset: this.elapsedTime });
      this.startProgressTracking();
      source.start();
      this.audioStarted = true;
      this.prefetchNext();
    } catch (error) {
      if (session === this.genId) this.failPlayback(error instanceof Error ? error.message : String(error));
    }
  }

  private finishStoredPlayback() {
    this.stopProgressTracking();
    this.audioStarted = false;
    this.playing = false;
    this.paused = false;
    this.currentMessageId = null;
    this.elapsedTime = this.totalDuration;
    if (this.audioCtx && this.audioCtx.state !== 'closed') void this.audioCtx.close().catch(() => {});
    this.audioCtx = null;
    if (this.queue.length) this.nextInSequence();
    else this.onPlaybackEnd?.();
  }

  private playBrowser(messageId: string, text: string, config: AppConfig) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      this.audioStarted = false;
    this.playing = false; this.currentMessageId = null; this.isGenerating = false; this.onPlaybackEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Number(config.tts?.speed || 1);
    u.volume = Math.max(0, Math.min(1, config.tts?.volume ?? 1));
    if (config.tts?.language) u.lang = config.tts.language;
    const voice = window.speechSynthesis.getVoices().find((voice) => voice.name === config.tts?.voice || voice.voiceURI === config.tts?.voice);
    if (voice) u.voice = voice;
    u.onstart = () => { if (this.currentMessageId === messageId) this.audioStarted = true; };
    u.onend = () => { if (this.currentMessageId === messageId) { this.audioStarted = false; this.playing = false; this.paused = false; this.currentMessageId = null; this.isGenerating = false; if (this.queue.length) this.nextInSequence(); else this.onPlaybackEnd?.(); } };
    u.onerror = () => { if (this.currentMessageId === messageId) { this.audioStarted = false; this.playing = false; this.currentMessageId = null; this.isGenerating = false; this.onPlaybackEnd?.(); } };
    try { window.speechSynthesis.speak(u); } catch {
      this.audioStarted = false;
    this.playing = false; this.currentMessageId = null; this.isGenerating = false;
    }
  }
}

export const ttsStore = new TtsStore();
