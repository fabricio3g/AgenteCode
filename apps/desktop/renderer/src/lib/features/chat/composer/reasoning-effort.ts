/** A thinking-token budget as people read it: 512, 2k, 24k, 1.5M. */
export function formatBudget(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1024;
    return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round(tokens / 100_000) / 10}M`;
}
