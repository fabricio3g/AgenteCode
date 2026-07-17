import { describe, expect, it } from 'vitest';
import { convertCurrency } from './fx.ts';

describe('convertCurrency (Frankfurter)', () => {
  it('returns 1:1 for same currency without network', async () => {
    const result = await convertCurrency({ amount: 50, from: 'usd', to: 'USD' });
    expect(result.rate).toBe(1);
    expect(result.result).toBe(50);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('rejects invalid currency codes', async () => {
    await expect(convertCurrency({ amount: 10, from: 'US', to: 'EUR' })).rejects.toThrow(/ISO/);
  });
});
