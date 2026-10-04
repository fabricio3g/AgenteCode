/** Endpointing runs locally; audio goes only to the selected speech service. */
export class VoiceActivity {
  private noise = .004;
  private startedAt = 0;
  private candidateAt: number | null = null;
  private lastSpeechAt = 0;
  speaking = false;
  reset(now = 0) { this.startedAt = now; this.candidateAt = null; this.lastSpeechAt = 0; this.speaking = false; }
  sample(rms: number, now: number, voiceLike = true): 'start' | 'end' | undefined {
    if (!Number.isFinite(rms)) return;
    const threshold = Math.max(.012, this.noise * 3);
    if (voiceLike && rms > threshold) {
      this.candidateAt ??= now;
      this.lastSpeechAt = now;
      if (!this.speaking && now - this.candidateAt >= 120) { this.speaking = true; this.startedAt = now; return 'start'; }
    } else {
      if (!this.speaking) { this.candidateAt = null; this.noise = this.noise * .96 + Math.min(rms, .006) * .04; }
      if (this.speaking && now - this.lastSpeechAt >= 600) { this.reset(now); return 'end'; }
    }
    if (this.speaking && now - this.startedAt >= 20_000) { this.reset(now); return 'end'; }
  }
}

/** Reject broad hiss, low hum and single tones before amplitude endpointing.
 * This is an acoustic gate, not a linguistic classifier: real speech still
 * has to be transcribed before it becomes a prompt.
 */
export function voiceLikeSpectrum(db: Float32Array, sampleRate: number): boolean {
  const binHz = sampleRate / (db.length * 2);
  let total = 0, band = 0, logBand = 0, bins = 0, peak = 0, peakIndex = 0;
  for (let index = 1; index < db.length; index++) {
    const hz = index * binHz;
    const power = Number.isFinite(db[index]) ? 10 ** (db[index] / 10) : 0;
    total += power;
    if (hz < 85 || hz > 6000) continue;
    band += power; logBand += Math.log(Math.max(power, 1e-12)); bins++;
    if (power > peak) { peak = power; peakIndex = index; }
  }
  if (!band || !bins || band / total < .6) return false;
  const flatness = Math.exp(logBand / bins) / (band / bins);
  let tone = 0;
  for (let index = Math.max(1, peakIndex - 1); index <= Math.min(db.length - 1, peakIndex + 1); index++) {
    tone += Number.isFinite(db[index]) ? 10 ** (db[index] / 10) : 0;
  }
  return flatness < .55 && tone / band < .8;
}

/** Discard explicit non-speech captions, retaining normal short replies in any language. */
export function spokenTranscript(text: string): string | undefined {
  const trimmed = text.trim();
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return;
  if (/^(?:\[(?:blank_audio|silence|noise|music|inaudible|applause)\]|\((?:silence|noise|music|inaudible|applause)\)|<\|[^>]+\|>)[.!\s]*$/i.test(trimmed)) return;
  return trimmed;
}

/** Decode short pauses early, but submit only after the whole spoken turn settles. */
export class PendingSpeech {
  private parts: string[] = [];
  private heardAt = 0;
  constructor(private readonly settleMs = 1600) {}
  heard(now: number) { this.heardAt = now; }
  append(text: string) { const part = spokenTranscript(text); if (part) this.parts.push(part); }
  get waiting() { return this.parts.length > 0; }
  take(now: number, pending: number, speaking: boolean): string | undefined {
    if (speaking || pending || !this.waiting || now - this.heardAt < this.settleMs) return;
    const text = this.parts.join(' '); this.parts = []; return text;
  }
  clear() { this.parts = []; this.heardAt = 0; }
}

/** Speak only complete sentences as they stream; flush the remainder at completion. */
export class SpokenReply {
  private consumed = 0;
  private previous = '';
  get position() { return this.consumed; }
  take(text: string, finished: boolean): string | undefined {
    if (!text.startsWith(this.previous)) this.consumed = 0;
    this.previous = text;
    const tail = text.slice(this.consumed);
    const matches = [...tail.matchAll(/[.!?](?:["')]*)(?:\s+|$)|\n\n/g)];
    const clause = tail.length > 40 ? [...tail.slice(0, 80).matchAll(/[,;:]\s+/g)].at(-1) : undefined;
    const phraseEnd = clause && clause.index >= 35 ? clause.index + clause[0].length : 0;
    const end = finished ? tail.length : matches.at(-1)?.index !== undefined ? matches.at(-1)!.index! + matches.at(-1)![0].length : phraseEnd;
    if (!end) return;
    this.consumed += end;
    return tail.slice(0, end).trim() || undefined;
  }
  skip(text: string) { this.previous = text; this.consumed = text.length; }
}
