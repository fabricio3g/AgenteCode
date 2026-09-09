import type { HfModelSearchItem } from '$lib/services/search';

/**
 * Pure helpers for model Explore presentation.
 * No stores, no IPC — safe to unit test in node.
 */

export function relativeDate(input?: string | number | null, nowMs: number = Date.now()): string {
  if (input === undefined || input === null || input === '') return '';
  const time = typeof input === 'number' ? input : Date.parse(String(input));
  if (!Number.isFinite(time)) return '';
  const startOfDay = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diff = Math.floor((startOfDay(nowMs) - startOfDay(time)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 30) return `${diff} days ago`;
  const date = new Date(time);
  const thisYear = new Date(nowMs).getFullYear();
  const withYear = date.getFullYear() !== thisYear ? { year: 'numeric' as const } : {};
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...withYear });
}

/** One-line summary for result rows: size, file count, largest artifact. */
export function repoSummaryLine(item: HfModelSearchItem): string {
  const parts: string[] = [];
  if (item.size_label) parts.push(String(item.size_label));
  const files = Array.isArray(item.gguf_files)
    ? (item.gguf_files as Array<{ size_human?: string }>)
    : [];
  if (files.length) {
    parts.push(`${files.length} GGUF file${files.length === 1 ? '' : 's'}`);
    const largest = files[0]?.size_human;
    if (largest) parts.push(`largest ${largest}`);
  } else if (typeof item.largest_gguf_human === 'string' && item.largest_gguf_human) {
    parts.push(`largest ${item.largest_gguf_human}`);
  }
  return parts.join(' · ');
}

/** Quantization tag from a GGUF filename. Mirrors main guessQuantization. */
export function quantFromFilename(filename: string): string {
  const match = String(filename || '').match(/(Q\d+_K_[SMLX]|Q\d+_[01]|IQ\d+_[A-Z0-9_]+|F16|F32|BF16)/i);
  return match ? match[1].toUpperCase() : '';
}

/** Compact count for stats rows: 872724 -> 872.7K. */
export function compactCount(value: number | undefined | null): string {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
