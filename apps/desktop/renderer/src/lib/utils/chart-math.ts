import type { ChartData } from './chart-data';
import type { ChartType } from './chart-types';

/** Reject misleading data rather than dropping values and shifting their labels. */
export function validateChartData(type: ChartType, data: ChartData): string {
  if (!data.labels.length || !data.datasets.length) return 'Provide labels and at least one series.';
  for (const series of data.datasets) {
    if (series.data.length !== data.labels.length) return `${series.label}: labels and values must have the same length.`;
    if (series.data.some((value) => !Number.isFinite(value))) return 'Every chart value must be a finite number.';
    if (series.sizes && (series.sizes.length !== data.labels.length || series.sizes.some((v) => !Number.isFinite(v) || v <= 0))) return 'Bubble sizes must be positive numbers, one per point.';
  }
  if (['scatter', 'bubble'].includes(type) && data.labels.some((v) => !v.trim() || !Number.isFinite(Number(v)))) return 'Scatter and bubble charts require numeric x values in labels.';
  if (type === 'radar' && data.labels.length < 3) return 'Radar charts require at least three dimensions.';
  if (['pie', 'donut', 'funnel', 'treemap', 'radar', 'gauge', 'percent_bar', 'percent_area', 'stacked_area'].includes(type)
    && data.datasets.some((s) => s.data.some((v) => v < 0))) return 'This chart requires non-negative values.';
  if (['pie', 'donut', 'funnel', 'treemap'].includes(type) && !data.datasets[0].data.some((v) => v > 0)) return 'Provide at least one positive value.';
  if (type === 'gauge' && (!Number.isFinite(data.max ?? 100) || (data.max ?? 100) <= 0 || data.datasets[0].data[0] > (data.max ?? 100))) return 'Gauge value must be between zero and max (100 by default).';
  return '';
}

export function stackValues(data: ChartData, percent = false): Array<Array<[number, number]>> {
  const positive = data.labels.map(() => 0);
  const negative = data.labels.map(() => 0);
  const totals = data.labels.map((_, i) => data.datasets.reduce((sum, ds) => sum + ds.data[i], 0));
  return data.datasets.map((ds) => ds.data.map((value, i) => {
    const v = percent ? totals[i] ? value / totals[i] * 100 : 0 : value;
    const base = v < 0 ? negative : positive;
    const start = base[i];
    base[i] += v;
    return [start, base[i]];
  }));
}

export function fiveNumbers(values: number[]): [number, number, number, number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => {
    const i = (sorted.length - 1) * p;
    const low = Math.floor(i);
    return sorted[low] + (sorted[Math.ceil(i)] - sorted[low]) * (i - low);
  };
  return [sorted[0], quantile(0.25), quantile(0.5), quantile(0.75), sorted.at(-1)!];
}

export function histogramBins(values: number[], count = Math.ceil(Math.sqrt(values.length))) {
  const min = Math.min(...values), max = Math.max(...values);
  const bins = Math.min(30, Math.max(1, count));
  const step = (max === min ? 1 : max - min) / bins;
  const result = Array.from({ length: bins }, (_, i) => ({ start: min + step * i, end: min + step * (i + 1), count: 0 }));
  for (const value of values) result[Math.min(bins - 1, Math.floor((value - min) / step))].count++;
  return result;
}

export function waterfallValues(values: number[]): Array<[number, number]> {
  let total = 0;
  return values.map((value) => { const start = total; total += value; return [start, total]; });
}
