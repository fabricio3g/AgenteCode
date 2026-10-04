import { PendingSpeech, spokenTranscript, voiceLikeSpectrum, VoiceActivity } from './voice-activity';
import { recordingToWav } from './wav-encode';
import { invoke } from '$lib/services/bridge';
import { sttTranscribe } from '$lib/services/stt';
import { micStateFromError, requestMicrophone } from './mic-probe';

export type CallPhase = 'idle' | 'permission' | 'listening' | 'error';
/** Persistent input capture, independent of model requests and output playback. */
export class VoiceCall {
  phase = $state<CallPhase>('idle');
  muted = $state(false);
  level = $state(0);
  speech = $state(false);
  noise = $state(false);
  transcribing = $state(false);
  waiting = $state(false);
  error = $state('');
  lastTranscript = $state('');
  deviceLabel = $state('');
  private epoch = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private recorder?: MediaRecorder;
  private timer?: ReturnType<typeof setInterval>;
  private vad = new VoiceActivity();
  private utterance = new PendingSpeech();
  private work: Promise<void> = Promise.resolve();
  private pending = 0;
  private segmentAt = 0;
  private hadSpeech = false;
  private utteranceAt = 0;
  private voiceEndAt = 0;
  private voicedMs = 0;

  constructor(private readonly callbacks: { onSpeech: () => void; onText: (text: string) => Promise<void> | void }) {}

  async start(deviceId?: string): Promise<void> {
    this.stop();
    const epoch = this.epoch;
    this.phase = 'permission'; this.error = ''; this.muted = false;
    void invoke('preload_whisper').catch(() => { /* Capture remains available; transcription reports actionable errors. */ });
    try {
      const stream = await requestMicrophone(deviceId);
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.deviceLabel = stream.getAudioTracks()[0]?.label || '';
      this.context = new AudioContext();
      await this.context.resume();
      if (epoch !== this.epoch) return;
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0;
      this.context.createMediaStreamSource(stream).connect(this.analyser);
      this.phase = 'listening'; this.vad.reset(performance.now());
      this.record(epoch);
      const samples = new Float32Array(this.analyser.fftSize);
      const spectrum = new Float32Array(this.analyser.frequencyBinCount);
      this.timer = setInterval(() => {
        if (epoch !== this.epoch || !this.analyser || this.muted) return;
        this.analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        this.level = Math.min(1, rms * 8);
        const now = performance.now();
        this.analyser.getFloatFrequencyData(spectrum);
        const voiceLike = voiceLikeSpectrum(spectrum, this.context!.sampleRate);
        const activity = this.vad.sample(rms, now, voiceLike);
        if (voiceLike && rms > .012) { this.voiceEndAt = now; this.voicedMs += 40; this.utterance.heard(now); }
        this.noise = !voiceLike && !this.vad.speaking && rms > .007;
        this.speech = this.vad.speaking;
        if (activity === 'start') { this.hadSpeech = true; this.utteranceAt = Math.max(this.segmentAt, now - 320); this.callbacks.onSpeech(); }
        if (activity === 'end' || (!this.hadSpeech && now - this.segmentAt > 8000)) this.rotate();
        const text = this.utterance.take(now, this.pending, this.speech);
        this.waiting = this.utterance.waiting;
        if (text) {
          this.lastTranscript = text;
          Promise.resolve().then(() => { if (epoch === this.epoch) return this.callbacks.onText(text); })
            .catch(error => { if (epoch === this.epoch) this.error = error instanceof Error ? error.message : String(error); });
        }
      }, 40);
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (epoch !== this.epoch) return;
        this.stop(); this.phase = 'error'; this.error = 'Microphone disconnected. Reconnect it and start the call again.';
      }, { once: true });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.stop(); this.phase = 'error';
      const state = micStateFromError(error);
      this.error = state === 'none' ? 'No microphone found. Connect one to start a call.' : state === 'busy'
        ? 'Microphone is in use. Choose another input in Voice settings.' : state === 'blocked'
        ? 'Microphone access is blocked. Allow it in your system settings and try again.' : String(error);
    }
  }

  private record(epoch: number) {
    if (!this.stream || this.muted || epoch !== this.epoch) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    this.segmentAt = performance.now(); this.hadSpeech = false; this.voicedMs = 0; this.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      if (epoch !== this.epoch) return;
      const spoken = this.hadSpeech && this.voicedMs >= 160 && !this.muted;
      const range = { start: Math.max(0, (this.utteranceAt - this.segmentAt) / 1000), end: Math.max(0, (this.voiceEndAt - this.segmentAt + 350) / 1000) };
      // Re-arm before transcription; the mic keeps capturing during STT/model/TTS.
      this.record(epoch);
      if (!spoken || !chunks.length) return;
      if (this.pending >= 4) { this.error = 'Transcription is catching up. Please pause briefly.'; return; }
      const blob = new Blob(chunks, { type: recorder.mimeType });
      this.pending++; this.transcribing = true;
      this.work = this.work.then(async () => {
        if (epoch !== this.epoch) return;
        let bytes: Uint8Array; let type = 'audio/wav';
        try { bytes = await recordingToWav(blob, range); }
        catch { bytes = new Uint8Array(await blob.arrayBuffer()); type = recorder.mimeType; }
        const result = await sttTranscribe(bytes, type, { live: true });
        const transcript = spokenTranscript(result.text ?? '');
        if (epoch !== this.epoch || !transcript) return;
        this.utterance.append(transcript); this.waiting = this.utterance.waiting; this.error = '';
      }).catch(error => { if (epoch === this.epoch) this.error = error instanceof Error ? error.message : String(error); })
        .finally(() => { if (epoch === this.epoch) { this.pending--; this.transcribing = this.pending > 0; } });
    };
    recorder.onerror = () => { if (epoch === this.epoch) { this.stop(); this.phase = 'error'; this.error = 'Microphone recording failed. Try starting the call again.'; } };
    recorder.start(200);
  }
  private rotate() { if (this.recorder?.state === 'recording') this.recorder.stop(); }
  toggleMute() {
    this.muted = !this.muted; this.level = 0; this.speech = false; this.noise = false;
    this.stream?.getAudioTracks().forEach(track => track.enabled = !this.muted);
    this.vad.reset(performance.now());
    if (this.muted) this.rotate(); else this.record(this.epoch);
  }
  stop() {
    this.epoch++;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop(); this.recorder = undefined;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    void this.context?.close().catch(() => {}); this.context = undefined; this.analyser = undefined;
    this.phase = 'idle'; this.level = 0; this.speech = false; this.noise = false; this.transcribing = false; this.pending = 0;
    this.work = Promise.resolve(); this.hadSpeech = false; this.utterance.clear(); this.waiting = false;
  }
}
