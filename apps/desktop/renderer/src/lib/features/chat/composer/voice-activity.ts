/** Endpointing runs locally; audio goes only to the selected speech service. */
export class VoiceActivity {
  private noise = .004;
  private startedAt = 0;
  private candidateAt: number | null = null;
  private lastSpeechAt = 0;
  speaking = false;
  reset(now = 0) { this.startedAt = now; this.candidateAt = null; this.lastSpeechAt = 0; this.speaking = false; }
  sample(rms: number, now: number): 'start' | 'end' | undefined {
    if (!Number.isFinite(rms)) return;
    const threshold = Math.max(.012, this.noise * 3);
    if (rms > threshold) {
      this.candidateAt ??= now;
      this.lastSpeechAt = now;
      if (!this.speaking && now - this.candidateAt >= 120) { this.speaking = true; this.startedAt = now; return 'start'; }
    } else {
      if (!this.speaking) { this.candidateAt = null; this.noise = this.noise * .98 + rms * .02; }
      if (this.speaking && now - this.lastSpeechAt >= 850) { this.reset(now); return 'end'; }
    }
    if (this.speaking && now - this.startedAt >= 20_000) { this.reset(now); return 'end'; }
  }
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
    const clause = tail.length > 100 ? [...tail.slice(0, 100).matchAll(/[,;:]\s+/g)].at(-1) : undefined;
    const phraseEnd = clause && clause.index >= 35 ? clause.index + clause[0].length : 0;
    const end = finished ? tail.length : matches.at(-1)?.index !== undefined ? matches.at(-1)!.index! + matches.at(-1)![0].length : phraseEnd;
    if (!end) return;
    this.consumed += end;
    return tail.slice(0, end).trim() || undefined;
  }
  skip(text: string) { this.previous = text; this.consumed = text.length; }
}
