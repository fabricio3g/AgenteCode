import { describe, expect, it } from 'vitest';
import { fitProjection, scaleForZoom, MAP_H, MAP_W } from './map-geo';
import {
  DEFAULT_TILE_TEMPLATE,
  MAX_TILE_ZOOM,
  tileUrl,
  tileZoomForScale,
  tilesForViewport
} from './map-tiles';

const MADRID = { lat: 40.4168, lng: -3.7038 };

function projectionAt(zoom: number) {
  return fitProjection({ center: MADRID, points: [MADRID], zoom });
}

describe('tileZoomForScale', () => {
  it('round-trips the zoom the projection was built at', () => {
    // The whole layer rests on this: d3 Mercator scale and slippy-map zoom describe
    // the same thing, so a projection built at z must ask for z tiles.
    for (const zoom of [0, 1, 4, 7, 10]) {
      expect(tileZoomForScale(scaleForZoom(zoom))).toBe(zoom);
    }
  });

  it('clamps to what providers actually serve', () => {
    expect(tileZoomForScale(scaleForZoom(40))).toBe(MAX_TILE_ZOOM);
    expect(tileZoomForScale(scaleForZoom(-10))).toBe(0);
  });

  it('survives a degenerate scale rather than returning NaN', () => {
    expect(tileZoomForScale(0)).toBe(0);
    expect(tileZoomForScale(Number.NaN)).toBe(0);
    expect(tileZoomForScale(-1)).toBe(0);
  });
});

describe('tileUrl', () => {
  it('fills every placeholder', () => {
    expect(tileUrl(DEFAULT_TILE_TEMPLATE, { x: 12, y: 34, z: 5 }))
      .toBe('https://tile.openstreetmap.org/5/12/34.png');
  });

  it('resolves {s} deterministically, so the same tile always hits the same cache entry', () => {
    const template = 'https://{s}.tile.example/{z}/{x}/{y}.png';
    const first = tileUrl(template, { x: 3, y: 4, z: 6 });
    expect(first).toBe(tileUrl(template, { x: 3, y: 4, z: 6 }));
    expect(first).toMatch(/^https:\/\/[abc]\.tile\.example\/6\/3\/4\.png$/);
  });
});

describe('tilesForViewport', () => {
  it('covers the viewport with no gaps between neighbours', () => {
    const tiles = tilesForViewport(projectionAt(6), { width: MAP_W, height: MAP_H });
    expect(tiles.length).toBeGreaterThan(0);

    // Every tile's right edge must meet its right-hand neighbour's left edge.
    for (const tile of tiles) {
      const right = tiles.find((other) => other.z === tile.z && other.y === tile.y && other.x === tile.x + 1);
      if (right) expect(right.sx).toBeCloseTo(tile.sx + tile.sw, 3);
      const below = tiles.find((other) => other.z === tile.z && other.x === tile.x && other.y === tile.y + 1);
      if (below) expect(below.sy).toBeCloseTo(tile.sy + tile.sh, 3);
    }
  });

  it('produces tiles that actually overlap the viewport', () => {
    const tiles = tilesForViewport(projectionAt(5), { width: MAP_W, height: MAP_H });
    for (const tile of tiles) {
      expect(tile.sx).toBeLessThan(MAP_W);
      expect(tile.sy).toBeLessThan(MAP_H);
      expect(tile.sx + tile.sw).toBeGreaterThan(0);
      expect(tile.sy + tile.sh).toBeGreaterThan(0);
    }
  });

  it('gives every tile a positive size and a unique key', () => {
    const tiles = tilesForViewport(projectionAt(4), { width: MAP_W, height: MAP_H });
    for (const tile of tiles) {
      expect(tile.sw).toBeGreaterThan(0);
      expect(tile.sh).toBeGreaterThan(0);
    }
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
  });

  it('keeps tile indices inside the pyramid at world zoom', () => {
    const tiles = tilesForViewport(projectionAt(0), { width: MAP_W, height: MAP_H });
    for (const tile of tiles) {
      const n = Math.pow(2, tile.z);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(n);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(n);
    }
  });

  it('stays bounded — a viewport must never request an unbounded tile count', () => {
    for (const zoom of [0, 3, 6, 9, 12]) {
      const tiles = tilesForViewport(projectionAt(zoom), { width: MAP_W, height: MAP_H });
      expect(tiles.length).toBeLessThanOrEqual(64);
    }
  });

  it('returns nothing rather than throwing when the projection cannot invert', () => {
    const broken = { ...projectionAt(4), invert: undefined } as unknown as ReturnType<typeof projectionAt>;
    expect(tilesForViewport(broken, { width: MAP_W, height: MAP_H })).toEqual([]);
  });
});
