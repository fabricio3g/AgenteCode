export interface CompletionRange { start: number; end: number; query: string; explicit: boolean }
export interface NameCandidate { id: string; name: string; nickname?: string; aliases?: string[]; avatar?: string; description?: string; disambiguate?: boolean }

/** UTF-16 offsets match textarea.selectionStart, while names may use any script. */
export function completionAt(text: string, caret: number, automatic = false): CompletionRange | null {
  const prefix = text.slice(0, caret);
  const end = caret + (/^[\p{L}\p{N}\p{M}_.'’\-]*/u.exec(text.slice(caret))?.[0].length ?? 0);
  const explicit = /(?:^|\s)@([\p{L}\p{N}\p{M}_.'’\- ]*)$/u.exec(prefix);
  if (explicit) return { start: caret - explicit[1].length - 1, end, query: explicit[1], explicit: true };
  const partial = automatic ? /(?:^|\s)([\p{L}\p{M}][\p{L}\p{N}\p{M}'’\-]{1,})$/u.exec(prefix) : null;
  return partial ? { start: caret - partial[1].length, end, query: partial[1], explicit: false } : null;
}

export function matchNames<T extends NameCandidate>(candidates: T[], query: string, limit = 6): T[] {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
  const needle = normalize(query);
  const rank = (candidate: T) => {
    const names = [candidate.name, candidate.nickname ?? '', ...(candidate.aliases ?? [])].filter(Boolean).map(normalize);
    return names.some((name) => name.startsWith(needle)) ? 0
      : names.some((name) => name.split(/\s+/).some((word) => word.startsWith(needle))) ? 1 : 2;
  };
  return candidates.filter((candidate) => rank(candidate) < 2).sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

/** Shared insertion primitive; callers decide whether a mention keeps its @. */
export function replaceCompletion(text: string, range: { start: number; end: number }, value: string): { text: string; caret: number } {
  const insertion = `${value}${text[range.end] === ' ' ? '' : ' '}`;
  return { text: text.slice(0, range.start) + insertion + text.slice(range.end), caret: range.start + value.length + 1 };
}
