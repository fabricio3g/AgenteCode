import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertCurrency } from '../../main/live-data/fx.ts';

describe('convertCurrency (Frankfurter)', () => {
  it('returns 1:1 for same currency without network', async () => {
    const result = await convertCurrency({ amount: 50, from: 'usd', to: 'USD' });
    assert.equal(result.rate, 1);
    assert.equal(result.result, 50);
    assert.ok(result.rows.length > 0);
  });

  it('rejects invalid currency codes', async () => {
    await assert.rejects(
      () => convertCurrency({ amount: 10, from: 'US', to: 'EUR' }),
      /ISO/
    );
  });
});
