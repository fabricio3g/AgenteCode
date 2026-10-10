import { copy } from '$lib/copy';

const PATTERNS: Array<[RegExp, keyof typeof copy.model.loadFailed]> = [
  [/unknown model architecture|unsupported (?:model|architecture|tensor type)|not supported (?:by|in) this (?:version|build)|GGUF.*software only supports/i, 'runtime'],
  [/out of memory|\boom\b|cudaMalloc|failed to allocate|insufficient memory|not enough memory/i, 'oom'],
  [/address already in use|EADDRINUSE|port .*in use/i, 'port'],
  [/runtime (?:not found|missing)|ENOENT.*llama-server|no runtime|spawn .*ENOENT|exited before|crashed/i, 'runtime'],
  [/failed to (?:load|read) model|invalid (?:magic|gguf)|gguf_init|file (?:not found|is corrupt)/i, 'file']
];

/** Turns a llama-server / supervisor failure into a sentence a person can act on. */
export function describeLocalLoadError(raw: string): string {
  const reason = String(raw || '').trim();
  for (const [pattern, key] of PATTERNS) {
    if (pattern.test(reason)) return copy.model.loadFailed[key];
  }
  return copy.model.loadFailed.generic.replace('{reason}', reason.slice(0, 300) || '—');
}
