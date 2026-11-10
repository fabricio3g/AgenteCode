import type { LessonPoint } from './simulation-model';

/**
 * Scales, ticks and paths shared by every plot in a lesson. Two components draw
 * curves (the explore block and the predict block); the geometry lives here so
 * they cannot drift apart.
 */

export interface PlotBox {
  width: number;
  height: number;
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
}

export interface PlotScale {
  x: (value: number) => number;
  y: (value: number) => number;
  invertX: (px: number) => number;
  invertY: (py: number) => number;
  xRange: [number, number];
  yRange: [number, number];
  box: Required<PlotBox>;
}

const DEFAULTS = { padLeft: 34, padRight: 10, padTop: 10, padBottom: 20 };

export function plotScale(points: LessonPoint[], box: PlotBox): PlotScale {
  const resolved = { ...DEFAULTS, ...box } as Required<PlotBox>;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xRange: [number, number] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
  let yRange: [number, number] = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 1];
  if (yRange[0] === yRange[1]) yRange = [yRange[0] - 1, yRange[1] + 1];
  // A flat line at zero should still sit on the axis, not in the middle.
  if (yRange[0] > 0 && yRange[0] < yRange[1]) yRange = [0, yRange[1]];
  if (yRange[1] < 0 && yRange[0] < yRange[1]) yRange = [yRange[0], 0];

  const innerWidth = Math.max(1, resolved.width - resolved.padLeft - resolved.padRight);
  const innerHeight = Math.max(1, resolved.height - resolved.padTop - resolved.padBottom);
  const xSpan = xRange[1] - xRange[0] || 1;
  const ySpan = yRange[1] - yRange[0] || 1;
  const x = (value: number) => resolved.padLeft + ((value - xRange[0]) / xSpan) * innerWidth;
  const y = (value: number) => resolved.padTop + innerHeight - ((value - yRange[0]) / ySpan) * innerHeight;
  return {
    x,
    y,
    invertX: (px: number) => xRange[0] + ((px - resolved.padLeft) / innerWidth) * xSpan,
    invertY: (py: number) => yRange[0] + ((resolved.padTop + innerHeight - py) / innerHeight) * ySpan,
    xRange,
    yRange,
    box: resolved
  };
}

export function pathFor(points: LessonPoint[], scale: PlotScale): string {
  if (!points.length) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${scale.x(point.x).toFixed(2)} ${scale.y(point.y).toFixed(2)}`)
    .join(' ');
}

export function areaPath(points: LessonPoint[], scale: PlotScale): string {
  if (!points.length) return '';
  const baseline = scale.y(scale.yRange[0]);
  const first = points[0];
  const last = points[points.length - 1];
  return `${pathFor(points, scale)} L${scale.x(last.x).toFixed(2)} ${baseline.toFixed(2)} L${scale.x(first.x).toFixed(2)} ${baseline.toFixed(2)} Z`;
}

/** Three ticks at most: a lesson plot is read, not measured. */
export function ticks(range: [number, number]): number[] {
  const [from, to] = range;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return [from];
  return [from, (from + to) / 2, to];
}

export function tickLabel(value: number): string {
  if (!Number.isFinite(value)) return '';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 10_000)) return value.toExponential(1);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

/** The zero line, when zero is inside the visible y range. */
export function zeroLine(scale: PlotScale): number | null {
  if (scale.yRange[0] > 0 || scale.yRange[1] < 0) return null;
  return scale.y(0);
}
