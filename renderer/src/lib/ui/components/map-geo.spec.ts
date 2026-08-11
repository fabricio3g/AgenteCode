import { describe, expect, it } from 'vitest';
import {
  MAP_H,
  MAP_W,
  clampZoom,
  cssColor,
  distanceKm,
  fitProjection,
  formatDistance,
  lineLengthKm,
  normalizeLine,
  normalizePoint,
  placeLabels,
  scaleBar,
  scaleForZoom,
  strokeWidth,
  type Point
} from './map-geo';

const VICTORIA: Point = { lat: -32.6167, lng: -60.15 };
const ROSARIO: Point = { lat: -32.9468, lng: -60.6393 };
const MADRID: Point = { lat: 40.4168, lng: -3.7038 };

describe('projection', () => {
  it('preserves aspect ratio — the bug the hand-rolled maths had', () => {
    /*
     * The previous implementation rescaled x and y independently against the content
     * bounds, so the map was anisotropically stretched. Invisible on a dashed grid; it
     * would have deformed every coastline the moment real geometry was drawn.
     *
     * Within one projection, equal angular spans at the equator must cover equal pixel
     * distances in x and y — that is exactly what independent scaling breaks.
     */
    const projection = fitProjection({
      center: { lat: 0, lng: 0 },
      points: [{ lat: -8, lng: -8 }, { lat: 8, lng: 8 }],
      zoom: 4
    });

    const west = projection([-1, 0])!;
    const east = projection([1, 0])!;
    const south = projection([0, -1])!;
    const north = projection([0, 1])!;

    const dx = Math.abs(east[0] - west[0]);
    const dy = Math.abs(north[1] - south[1]);
    expect(dx).toBeGreaterThan(0);
    expect(dy / dx).toBeCloseTo(1, 2);
  });

  it('keeps every supplied point inside the drawing surface', () => {
    const points = [VICTORIA, ROSARIO, MADRID];
    const projection = fitProjection({ center: VICTORIA, points, zoom: 3 });
    for (const point of points) {
      const xy = projection([point.lng, point.lat]);
      expect(xy).not.toBeNull();
      expect(xy![0]).toBeGreaterThanOrEqual(0);
      expect(xy![0]).toBeLessThanOrEqual(MAP_W);
      expect(xy![1]).toBeGreaterThanOrEqual(0);
      expect(xy![1]).toBeLessThanOrEqual(MAP_H);
    }
  });

  it('centres a single point and honours the requested zoom literally', () => {
    const projection = fitProjection({ center: MADRID, points: [MADRID], zoom: 6 });
    const xy = projection([MADRID.lng, MADRID.lat])!;
    expect(xy[0]).toBeCloseTo(MAP_W / 2, 1);
    expect(xy[1]).toBeCloseTo(MAP_H / 2, 1);
    expect(projection.scale()).toBeCloseTo(scaleForZoom(6), 5);
  });

  it('falls back to the centre when there are no points at all', () => {
    const projection = fitProjection({ center: MADRID, points: [], zoom: 5 });
    const xy = projection([MADRID.lng, MADRID.lat])!;
    expect(xy[0]).toBeCloseTo(MAP_W / 2, 1);
    expect(xy[1]).toBeCloseTo(MAP_H / 2, 1);
  });

  it('does not blow up when two points coincide', () => {
    // fitExtent on a zero-extent collection drives scale to infinity.
    const projection = fitProjection({ center: MADRID, points: [MADRID, { ...MADRID }], zoom: 5 });
    expect(Number.isFinite(projection.scale())).toBe(true);
    const xy = projection([MADRID.lng, MADRID.lat])!;
    expect(Number.isFinite(xy[0])).toBe(true);
    expect(Number.isFinite(xy[1])).toBe(true);
  });

  it('maps web-mercator zoom to a world width of 256 * 2^z pixels', () => {
    expect(scaleForZoom(0) * 2 * Math.PI).toBeCloseTo(256, 6);
    expect(scaleForZoom(4) * 2 * Math.PI).toBeCloseTo(256 * 16, 6);
  });

  it('clamps zoom into the range the bundled geometry can actually support', () => {
    expect(clampZoom(-5)).toBe(0);
    expect(clampZoom(99)).toBe(10);
    expect(clampZoom('thick')).toBe(4);
    expect(clampZoom(7)).toBe(7);
  });
});

describe('distance', () => {
  it('measures great-circle distance', () => {
    // Victoria → Rosario is roughly 55 km.
    expect(distanceKm(VICTORIA, ROSARIO)).toBeGreaterThan(40);
    expect(distanceKm(VICTORIA, ROSARIO)).toBeLessThan(70);
  });

  it('sums a multi-segment line', () => {
    const direct = distanceKm(VICTORIA, ROSARIO);
    const viaMidpoint = lineLengthKm([VICTORIA, { lat: -32.78, lng: -60.4 }, ROSARIO]);
    expect(viaMidpoint).toBeGreaterThanOrEqual(direct - 0.5);
  });

  it('formats by magnitude', () => {
    expect(formatDistance(0.4)).toBe('400 m');
    expect(formatDistance(55.2)).toBe('55.2 km');
    expect(formatDistance(1234)).toMatch(/^1[,.\s]?234 km$/);
  });
});

describe('scale bar', () => {
  it('reports a round distance, not a round pixel count', () => {
    const projection = fitProjection({ center: MADRID, points: [MADRID], zoom: 6 });
    const bar = scaleBar(projection, MAP_H / 2);
    expect(bar).not.toBeNull();
    expect(bar!.px).toBeGreaterThan(0);
    expect(bar!.px).toBeLessThanOrEqual(120);
    expect(bar!.label).toMatch(/^(1|2|5)(0*)(\.\d)? (m|km)$|^[125](,\d{3})* km$/);
  });
});

describe('input hardening survives the rewrite', () => {
  it('skips a null polyline entry instead of throwing', () => {
    expect(normalizeLine(null)).toBeNull();
    expect(normalizeLine(undefined)).toBeNull();
    expect(normalizeLine('nope')).toBeNull();
    expect(normalizeLine({})).toBeNull();
  });

  it('accepts both the bare-array and object polyline shapes', () => {
    expect(normalizeLine([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }])?.coords).toHaveLength(2);
    expect(normalizeLine({ coords: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }] })?.coords).toHaveLength(2);
  });

  it('drops a line that has fewer than two valid points', () => {
    expect(normalizeLine({ coords: [{ lat: 1, lng: 2 }] })).toBeNull();
    expect(normalizeLine({ coords: [{ lat: 'x', lng: 'y' }, { lat: 1, lng: 2 }] })).toBeNull();
  });

  it('rejects non-finite coordinates', () => {
    expect(normalizePoint({ lat: NaN, lng: 0 })).toBeNull();
    expect(normalizePoint({ lat: 0, lng: Infinity })).toBeNull();
    expect(normalizePoint(null)).toBeNull();
    expect(normalizePoint({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2, label: undefined, popup: undefined });
  });

  it('keeps a malformed weight from invalidating stroke-width', () => {
    expect(strokeWidth('thick')).toBe(3);
    expect(strokeWidth(0)).toBe(1.5);
    expect(strokeWidth(500)).toBe(24);
    expect(strokeWidth(6)).toBe(6);
  });

  it('refuses a colour that would inject extra declarations', () => {
    expect(cssColor('red;background:magenta')).toBe('var(--primary)');
    expect(cssColor('blue-500')).toBe('var(--primary)');
    expect(cssColor('a'.repeat(40))).toBe('var(--primary)');
    expect(cssColor('#22d3ee')).toBe('#22d3ee');
    expect(cssColor('rebeccapurple')).toBe('rebeccapurple');
    expect(cssColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
  });
});

describe('label placement', () => {
  it('drops labels that would overlap, keeping the higher priority one', () => {
    const placed = placeLabels([
      { x: 100, y: 100, text: 'Important', priority: 10 },
      { x: 104, y: 101, text: 'Overlapping', priority: 1 }
    ]);
    expect(placed.map((l) => l.text)).toEqual(['Important']);
  });

  it('keeps labels that are far enough apart', () => {
    const placed = placeLabels([
      { x: 100, y: 100, text: 'One', priority: 5 },
      { x: 400, y: 300, text: 'Two', priority: 4 }
    ]);
    expect(placed).toHaveLength(2);
  });

  it('drops labels that fall outside the surface', () => {
    expect(placeLabels([{ x: -50, y: 100, text: 'Offscreen', priority: 9 }])).toEqual([]);
    expect(placeLabels([{ x: MAP_W + 50, y: 100, text: 'Offscreen', priority: 9 }])).toEqual([]);
  });

  it('ignores blank text', () => {
    expect(placeLabels([{ x: 100, y: 100, text: '   ', priority: 9 }])).toEqual([]);
  });
});
