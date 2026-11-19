import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMathExpression,
  handleCalculator
} from '../../renderer/src/lib/services/agent-tool-core.ts';

describe('safe calculator parser', () => {
  it('evaluates arithmetic, precedence, unary operators, scientific notation, and parentheses', () => {
    assert.equal(evaluateMathExpression('1 + 2 * 3'), 7);
    assert.equal(evaluateMathExpression('(1 + 2) * 3'), 9);
    assert.equal(evaluateMathExpression('10 - 3 - 2'), 5);
    assert.equal(evaluateMathExpression('20 / 4 / 2'), 2.5);
    assert.equal(evaluateMathExpression('17 % 5'), 2);
    assert.equal(evaluateMathExpression('2 ** 3 ** 2'), 512);
    assert.equal(evaluateMathExpression('-2 ** 2'), -4);
    assert.equal(evaluateMathExpression('(-2) ** 2'), 4);
    assert.equal(evaluateMathExpression('2 ** -3'), 0.125);
    assert.equal(evaluateMathExpression('+42 + -2'), 40);
    assert.equal(evaluateMathExpression('.5 + 1.5e2'), 150.5);
    assert.equal(evaluateMathExpression('2.5E-2 * 100'), 2.5);
  });

  it('supports constants and allowlisted Math functions with or without Math. prefix', () => {
    assert.equal(evaluateMathExpression('Math.PI'), Math.PI);
    assert.equal(evaluateMathExpression('PI * 2'), Math.PI * 2);
    assert.equal(evaluateMathExpression('Math.E + E'), Math.E * 2);
    assert.equal(evaluateMathExpression('Math.sqrt(81) + cbrt(27)'), 12);
    assert.equal(evaluateMathExpression('Math.pow(2, 10)'), 1024);
    assert.equal(evaluateMathExpression('min(5, -2, 9) + max(1, 4, 2)'), 2);
    assert.equal(evaluateMathExpression('abs(-7) + ceil(1.2) + floor(1.8) + round(2.6) + trunc(-3.9)'), 10);
    assert.equal(evaluateMathExpression('Math.hypot(3, 4)'), 5);
    assert.equal(evaluateMathExpression('Math.log10(1000) + log2(8)'), 6);
    assert.equal(evaluateMathExpression('sign(-42)'), -1);
    assert.ok(Math.abs(evaluateMathExpression('sin(PI / 2) + cos(0) + tan(0)') - 2) < 1e-12);
    assert.ok(Math.abs(evaluateMathExpression('asin(1) - PI / 2')) < 1e-12);
    assert.ok(Math.abs(evaluateMathExpression('acos(1) + atan(0) + atan2(0, 1)')) < 1e-12);
    assert.ok(Math.abs(evaluateMathExpression('log(exp(3)) - 3')) < 1e-12);
  });

  it('rejects JavaScript injection payloads and non-allowlisted identifiers', () => {
    const payloads = [
      'process.exit(1)',
      'globalThis.fetch("http://127.0.0.1")',
      'this.constructor.constructor("return process")()',
      'Math.constructor("return 1")()',
      'Function("return 1")()',
      'eval("1+1")',
      'Math.random()',
      '__proto__',
      'toString()',
      '1; 2',
      '(() => 1)()',
      '[1][0]',
      'window.location',
      '1 + foo',
      'Math.sqrt()',
      'Math.pow(2)',
      '1 2',
      '(',
    ];
    for (const payload of payloads) {
      assert.throws(
        () => evaluateMathExpression(payload),
        `Expected calculator to reject payload: ${payload}`
      );
    }
  });

  it('integrates cleanly with handleCalculator ok/fail/failFromError', () => {
    const ok = (output) => ({ success: true, output });
    const fail = (error) => ({ success: false, error });
    const failFromError = (err) => ({ success: false, error: err instanceof Error ? err.message : String(err) });

    const good = handleCalculator({ args: { expression: 'Math.sqrt(144) + 3' }, ok, fail, failFromError });
    assert.equal(good.success, true);
    assert.deepEqual(good.output, { expression: 'Math.sqrt(144) + 3', result: 15 });

    const bad = handleCalculator({ args: { expression: 'Math.constructor("return process")()' }, ok, fail, failFromError });
    assert.equal(bad.success, false);
    assert.ok(bad.error);
  });
});
