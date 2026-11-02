import { describe, expect, it } from 'vitest';
import { emptySpend } from './code-run';
import { conversationSpend, spendCostLabel, spendLabel } from './accounting';
import { addCallSpend } from '$shared/accounting';
import type { ChatMessage } from '$lib/types/chat';
import { formatPricePerMillion, formatUsd } from '$lib/utils/money';

/** A spend record with only the fields a label reads. */
function spend(costUsd: number, over: Partial<ReturnType<typeof emptySpend>> = {}) {
  return { ...emptySpend(), costUsd, ...over };
}

/*
 * The same table is asserted on the Rust side in
 * `crates/agente-tui/src/state/agent.rs`. If one surface starts rounding
 * differently the two specs disagree, which is the point: `$0.042` used to
 * read `$0.04` in the TUI and `$0.040` here.
 */
describe('money formatting', () => {
  it.each([
    [0.0004, '<$0.001'],
    [0.004, '$0.004'],
    [0.042, '$0.042'],
    [0.1, '$0.100'],
    [1, '$1.00'],
    [12.3, '$12.30']
  ])('formats %s as %s', (usd, expected) => {
    expect(formatUsd(usd)).toBe(expected);
  });

  it('formats a per-million rate without trailing zeros', () => {
    expect(formatPricePerMillion(3, 'free')).toBe('$3.00');
    expect(formatPricePerMillion(0.15, 'free')).toBe('$0.15');
    expect(formatPricePerMillion(0.014, 'free')).toBe('$0.014');
    expect(formatPricePerMillion(0, 'free')).toBe('free');
    expect(formatPricePerMillion(null, 'free')).toBe('');
  });
});

describe('spend labels', () => {
  it('distinguishes allowance consumption, estimates, missing prices and free calls', () => {
    const total = emptySpend();
    const usage = { prompt_tokens: 100, completion_tokens: 50, cache_read_tokens: 900, cache_creation_tokens: 0, context_tokens: 1000 };
    addCallSpend(total, { type: 'call_usage', usage, cost_usd: 0.00412, cost_estimated: false });
    expect(spendCostLabel(total)).toBe('$0.004');
    addCallSpend(total, { type: 'call_usage', usage, cost_usd: null, cost_estimated: true });
    expect(spendCostLabel(total)).toBe('~$0.004+');
    const unknown = emptySpend();
    addCallSpend(unknown, { type: 'call_usage', usage, cost_usd: NaN, cost_estimated: false });
    expect(unknown.unpriced).toBe(true);
    expect(spendCostLabel(unknown)).toBe('');
  });

  it('totals the selected reply versions and current streaming metadata', () => {
    const messages = [
      { id: 'saved', role: 'assistant', activeVersion: 1, metadata: { codeSpend: spend(9) }, versions: [{ metadata: { codeSpend: spend(2) } }, { metadata: { codeSpend: spend(3) } }] },
      { id: 'live', role: 'assistant', status: 'streaming', metadata: { codeSpend: spend(0.1) }, versions: [{ metadata: {} }] }
    ] as ChatMessage[];
    expect(conversationSpend(messages).costUsd).toBe(3.1);
    expect(conversationSpend(messages, { assistantMessageId: 'live', spend: spend(0.2) }).costUsd).toBe(3.2);
  });
  it('marks only what was actually reported', () => {
    // Provider-reported charge: no marker.
    expect(spendCostLabel(spend(0.042, { promptTokens: 100 }))).toBe('$0.042');
    // One call priced from the catalog: ours, so `~`.
    expect(spendCostLabel(spend(0.042, { promptTokens: 100, estimated: true }))).toBe('~$0.042');
    // Some calls had no price at all.
    expect(spendCostLabel(spend(0.042, { promptTokens: 100, unpriced: true }))).toBe('$0.042+');
  });

  it('says free instead of a fake zero', () => {
    expect(spendCostLabel(spend(0, { promptTokens: 10 }))).toBe('free');
    // Nothing reported, nothing to claim.
    expect(spendCostLabel(emptySpend())).toBe('');
  });

  it('puts the cache rate beside the money', () => {
    expect(spendLabel(spend(0.007, { promptTokens: 200, cacheReadTokens: 800 }))).toBe('$0.007 · 80% cached');
  });
});
