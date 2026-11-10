import { describe, expect, it } from 'vitest';
import { compileExpression, evaluateExpression, formatLessonNumber, sampleSeries } from './simulation-model';

describe('lesson expression model', () => {
  it('respects precedence and parentheses', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512);
  });

  it('treats unary minus as applying to the power', () => {
    expect(evaluateExpression('-2 ^ 2')).toBe(-4);
    expect(evaluateExpression('(-2) ^ 2')).toBe(4);
    expect(evaluateExpression('3 * -2')).toBe(-6);
  });

  it('accepts the implicit multiplication formulas are written with', () => {
    expect(evaluateExpression('2x', { x: 5 })).toBe(10);
    expect(evaluateExpression('2(x + 1)', { x: 5 })).toBe(12);
    expect(evaluateExpression('(a)(b)', { a: 3, b: 4 })).toBe(12);
    expect(evaluateExpression('2 sin(0)')).toBe(2 * Math.sin(0));
  });

  it('knows functions and constants', () => {
    expect(evaluateExpression('sqrt(9)')).toBe(3);
    expect(evaluateExpression('max(1, 4, 2)')).toBe(4);
    expect(evaluateExpression('2 * pi')!.toFixed(4)).toBe((Math.PI * 2).toFixed(4));
    expect(evaluateExpression('log(1000)')).toBe(3);
  });

  it('fails closed instead of throwing into the card', () => {
    expect(evaluateExpression('2 * unknown', {})).toBeNull();
    expect(evaluateExpression('1 / 0')).toBeNull();
    expect(evaluateExpression('((2 + 3) * ')).toBeNull();
    expect(evaluateExpression('window.alert(1)')).toBeNull();
    expect(() => compileExpression('1 + +')).toThrow();
  });

  it('lists the variables an expression needs', () => {
    expect(compileExpression('0.5 * g * t ^ 2').variables).toEqual(['g', 't']);
    expect(compileExpression('2 * pi').variables).toEqual([]);
  });

  it('samples a series over the plotted variable', () => {
    const points = sampleSeries({ expression: 'x ^ 2', variable: 'x', from: 0, to: 2, samples: 20 });
    expect(points.length).toBeGreaterThan(10);
    expect(points[0].x).toBe(0);
    expect(points.at(-1)!.y).toBeCloseTo(4, 5);
    expect(sampleSeries({ expression: 'nope(', variable: 'x', from: 0, to: 1 })).toEqual([]);
  });

  it('never renders a bare NaN', () => {
    expect(formatLessonNumber(null)).toBe('—');
    expect(formatLessonNumber(Number.NaN)).toBe('—');
    expect(formatLessonNumber(1234.567)).toMatch(/1,?234/);
    expect(formatLessonNumber(0.5, 'percent')).toContain('50');
    expect(formatLessonNumber(3, 'number', 'm')).toContain('m');
  });
});
