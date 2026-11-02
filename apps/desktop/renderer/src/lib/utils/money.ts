/**
 * Money, in the one place both surfaces agree on.
 *
 * The TUI's `state::format_usd` implements exactly this rule; a spec on each
 * side asserts the same table, so `$0.042` cannot read `$0.04` on one surface
 * and `$0.040` on the other. The rule:
 *
 * ```
 * <$0.001   below a tenth of a cent (never a fake $0.000)
 * $0.042    three decimals below a dollar
 * $12.30    two decimals above
 * ```
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.000';
  if (usd < 0.001) return '<$0.001';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * A *rate* (USD per million tokens), not money spent: `$3.00`, `$0.15`,
 * `$0.014`. Model cards and the context ring's price lines read this, so one
 * model never shows two different prices for the same token.
 */
export function formatPricePerMillion(value: number | null | undefined, free: string): string {
  if (value == null || !Number.isFinite(value)) return '';
  if (value === 0) return free;
  if (value < 0.1) return `$${value.toFixed(3).replace(/0+$/, '')}`;
  return `$${value.toFixed(2)}`;
}
