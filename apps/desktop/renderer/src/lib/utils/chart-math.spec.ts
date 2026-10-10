import { describe, expect, it } from 'vitest';
import { fiveNumbers, histogramBins, stackValues, validateChartData, waterfallValues } from './chart-math';
import { resolveChartType } from './chart-types';
import { parseChartData } from './chart-data';
const data = { labels: ['A', 'B'], datasets: [{ label: 'One', data: [10, -4] }, { label: 'Two', data: [20, -6] }] };
describe('chart data integrity', () => {
  it('stacks positive and negative values separately', () => {
    expect(stackValues(data)).toEqual([[[0, 10], [0, -4]], [[10, 30], [-4, -10]]]);
  });
  it('normalizes each category, including a zero total', () => {
    const stacks = stackValues({ labels: ['A', 'B'], datasets: [{ label: '1', data: [1, 0] }, { label: '2', data: [3, 0] }] }, true);
    expect(stacks).toEqual([[[0, 25], [0, 0]], [[25, 100], [0, 0]]]);
  });
  it('counts every histogram sample, including the upper boundary and constant samples', () => {
    expect(histogramBins([1, 1, 2, 3, 4], 2).map((bin) => bin.count)).toEqual([3, 2]);
    expect(histogramBins([7, 7, 7], 1)[0].count).toBe(3);
  });
  it('computes quartiles and running changes without sorting the source', () => {
    expect(fiveNumbers([4, 1, 3, 2])).toEqual([1, 1.75, 2.5, 3.25, 4]);
    expect(waterfallValues([10, -3, 5])).toEqual([[0, 10], [10, 7], [7, 12]]);
  });
  it('rejects unsafe, misaligned and semantically invalid series', () => {
    expect(validateChartData('bar', { ...data, labels: ['A'] })).toMatch(/same length/);
    expect(validateChartData('pie', data)).toMatch(/non-negative/);
    expect(validateChartData('scatter', data)).toMatch(/numeric x/);
    expect(validateChartData('bar', { ...data, datasets: [{ label: 'A', data: [NaN, 2] }] })).toMatch(/finite/);
    expect(validateChartData('gauge', { labels: ['Rate'], datasets: [{ label: 'Rate', data: [120] }] })).toMatch(/max/);
  });
  it('never silently drops bad points or downgrades meaningful chart aliases', () => {
    expect(parseChartData('{"labels":["A","B"],"datasets":[{"data":[1,"bad"]}]}')).toBeNull();
    expect(resolveChartType('stacked-area')).toBe('stacked_area');
    expect(resolveChartType('histogram')).toBe('histogram');
    expect(resolveChartType('horizontal-bar')).toBe('horizontal_bar');
  });
});
