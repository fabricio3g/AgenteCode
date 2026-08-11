/**
 * Raster tile layer for the map artifact.
 *
 * Deliberately *not* Leaflet or MapLibre. `d3.geoMercator` is web Mercator, which is
 * the same projection slippy-map tiles are cut in, so a tile is an axis-aligned
 * rectangle in the projection we already have. That means tiles can be `<image>`
 * elements inside the existing SVG, and every other layer — markers, routes, labels,
 * the scale bar — keeps working unchanged on top of them. A second renderer would have
 * meant maintaining two coordinate systems and two DOM trees for no gain.
 *
 * Tiles are the *default* surface; the bundled Natural Earth geometry in `map-atlas.ts`
 * is the fallback when they cannot be fetched. See `ArtifactMap.svelte`.
 */

import type { GeoProjection } from 'd3-geo';

export type Tile = {
  x: number;
  y: number;
  z: number;
  /** Screen-space rect in the SVG's coordinate system. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  key: string;
};

/**
 * Tile servers are shared infrastructure. OpenStreetMap's public endpoint explicitly
 * forbids use by redistributed applications, so this is only a development default —
 * ship against a provider you have an API key for (MapTiler, Stadia, Carto) by
 * overriding the template in settings.
 */
export const DEFAULT_TILE_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Required by the ODbL when OSM-derived tiles are shown. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Most providers stop at 19; past that the server returns nothing useful. */
export const MAX_TILE_ZOOM = 19;

/** A viewport should never need more than this; a runaway loop means bad input. */
const MAX_TILES = 64;

/**
 * Integer tile zoom for a projection scale.
 *
 * A d3 Mercator of scale k spans `2π·k` pixels for the whole world, and at tile zoom z
 * the world is `256·2^z` pixels. Rounding rather than flooring picks the level whose
 * native resolution is closest, which keeps labels in the tile imagery legible instead
 * of upscaled.
 */
export function tileZoomForScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const z = Math.log2((2 * Math.PI * scale) / 256);
  return Math.max(0, Math.min(MAX_TILE_ZOOM, Math.round(z)));
}

/** Web Mercator inverse for the y axis: tile row → latitude in degrees. */
function latForTileY(y: number, n: number): number {
  const t = Math.PI * (1 - (2 * y) / n);
  return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
}

function lngForTileX(x: number, n: number): number {
  return (x / n) * 360 - 180;
}

function tileXForLng(lng: number, n: number): number {
  return ((lng + 180) / 360) * n;
}

function tileYForLat(lat: number, n: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
}

export function tileUrl(template: string, tile: { x: number; y: number; z: number }): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
    // Subdomain rotation is legacy but some templates still carry it; pick one
    // deterministically so the same tile always resolves to the same URL and caches.
    .replace('{s}', 'abc'[(tile.x + tile.y) % 3]);
}

/**
 * The tiles covering the viewport, with their screen rects already computed.
 *
 * Returns an empty list rather than throwing on a projection that cannot invert — the
 * caller falls back to vector geography, which is always safe.
 */
export function tilesForViewport(
  projection: GeoProjection,
  options: { width: number; height: number; zoom?: number }
): Tile[] {
  const { width, height } = options;
  if (!projection.invert) return [];

  const z = options.zoom ?? tileZoomForScale(projection.scale());
  const n = Math.pow(2, z);

  // Invert the viewport corners to get the geographic window. Mercator is
  // axis-aligned, so the corners are enough — no need to walk the edges.
  const topLeft = projection.invert([0, 0]);
  const bottomRight = projection.invert([width, height]);
  if (!topLeft || !bottomRight) return [];
  if (![...topLeft, ...bottomRight].every(Number.isFinite)) return [];

  const clampIndex = (value: number) => Math.max(0, Math.min(n - 1, value));
  const x0 = clampIndex(Math.floor(tileXForLng(topLeft[0], n)));
  const x1 = clampIndex(Math.floor(tileXForLng(bottomRight[0], n)));
  const y0 = clampIndex(Math.floor(tileYForLat(topLeft[1], n)));
  const y1 = clampIndex(Math.floor(tileYForLat(bottomRight[1], n)));

  const tiles: Tile[] = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      // Project the tile's own corners rather than assuming a uniform grid step: at
      // low zoom a single tile can span a large, non-linear slice of the y axis.
      const nw = projection([lngForTileX(x, n), latForTileY(y, n)]);
      const se = projection([lngForTileX(x + 1, n), latForTileY(y + 1, n)]);
      if (!nw || !se) continue;
      const sw = se[0] - nw[0];
      const sh = se[1] - nw[1];
      if (!(sw > 0) || !(sh > 0)) continue;

      tiles.push({ x, y, z, sx: nw[0], sy: nw[1], sw, sh, key: `${z}/${x}/${y}` });
      if (tiles.length >= MAX_TILES) return tiles;
    }
  }

  return tiles;
}
