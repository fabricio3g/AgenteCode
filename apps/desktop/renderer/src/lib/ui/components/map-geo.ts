/**
 * Projection and measurement helpers for the inline map artifact.
 *
 * Split out of `ArtifactMap.svelte` so the geometry is testable without mounting a
 * component — the previous hand-rolled maths had no coverage and shipped a real bug
 * (see `fitProjection`).
 */

import { geoMercator, geoDistance, type GeoProjection } from 'd3-geo';

export type Point = { lat: number; lng: number; label?: string; popup?: string };
export type Line = { coords: Point[]; color?: string; weight?: number; label?: string };

/** Logical drawing surface. CSS scales the SVG; this is the coordinate space. */
export const MAP_W = 720;
export const MAP_H = 420;
export const MAP_PAD = 34;

const EARTH_RADIUS_KM = 6371;

/**
 * Web Mercator zoom → d3 projection scale.
 *
 * At zoom z the world is `256 * 2^z` pixels wide, and a d3 Mercator projection of
 * scale k spans `2π · k`. Equating the two is what makes `zoom` mean the same thing
 * here as it does everywhere else that speaks slippy-map coordinates.
 */
export function scaleForZoom(zoom: number): number {
  return (256 * Math.pow(2, zoom)) / (2 * Math.PI);
}

export function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizePoint(
  point: { lat?: number; lng?: number; label?: string; popup?: string } | null | undefined
): Point | null {
  if (!point) return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, label: point.label, popup: point.popup };
}

export function normalizeLine(line: unknown): Line | null {
  // The schema is `z.array(z.unknown())` and the tool passes elements through
  // untouched, so a null entry is reachable. Dereferencing `line.coords` without this
  // guard threw during render and took the whole message down with it.
  if (!line || typeof line !== 'object') return null;
  if (Array.isArray(line)) {
    const coords = line.map(normalizePoint).filter(Boolean) as Point[];
    return coords.length > 1 ? { coords } : null;
  }
  const source = line as { coords?: unknown; color?: string; weight?: number; label?: string };
  const raw = Array.isArray(source.coords) ? source.coords : [];
  const coords = raw.map(normalizePoint).filter(Boolean) as Point[];
  return coords.length > 1
    ? { coords, color: source.color, weight: source.weight, label: source.label }
    : null;
}

/** `Number('thick')` is NaN, which invalidates stroke-width and silently thins the line to 1. */
export function strokeWidth(weight: unknown): number {
  return Math.max(1.5, Math.min(24, finiteNumber(weight, 3)));
}

/**
 * Model-supplied colours land in an inline style, so anything containing a declaration
 * separator or comment could inject extra CSS. Allow only the shapes a colour can
 * legitimately take.
 */
export function cssColor(value: unknown): string {
  const candidate = String(value ?? '').trim();
  if (!candidate || candidate.length > 32) return 'var(--primary)';
  return /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\))$/i.test(candidate)
    ? candidate
    : 'var(--primary)';
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Point, b: Point): number {
  return geoDistance([a.lng, a.lat], [b.lng, b.lat]) * EARTH_RADIUS_KM;
}

/** Total great-circle length of a polyline, in kilometres. */
export function lineLengthKm(coords: Point[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distanceKm(coords[i - 1], coords[i]);
  return total;
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

/**
 * Build the projection for a set of features.
 *
 * `fitExtent` is doing the important work. The previous implementation rescaled x and
 * y **independently** against the content bounds, so the map was anisotropically
 * stretched — invisible on a dashed grid, but it would have visibly deformed every
 * coastline the moment real geometry was drawn. `fitExtent` preserves aspect ratio by
 * construction.
 *
 * A single point has no extent to fit, so it falls back to the requested `zoom` —
 * which is also the only case where `zoom` is honoured literally.
 */
export function fitProjection(params: {
  center: Point;
  points: Point[];
  zoom: number;
  width?: number;
  height?: number;
  pad?: number;
}): GeoProjection {
  const width = params.width ?? MAP_W;
  const height = params.height ?? MAP_H;
  const pad = params.pad ?? MAP_PAD;
  const projection = geoMercator();

  const distinct: Point[] = [];
  for (const point of params.points) {
    if (!distinct.some((seen) => seen.lat === point.lat && seen.lng === point.lng)) {
      distinct.push(point);
    }
  }

  if (distinct.length < 2) {
    const anchor = distinct[0] ?? params.center;
    return projection
      .center([anchor.lng, anchor.lat])
      .scale(scaleForZoom(clampZoom(params.zoom)))
      .translate([width / 2, height / 2]);
  }

  const collection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: distinct.map((point) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [point.lng, point.lat] }
    }))
  };

  projection.fitExtent(
    [
      [pad, pad],
      [width - pad, height - pad]
    ],
    collection
  );

  /*
   * The fitted scale is deliberately NOT clamped to MAX_ZOOM.
   *
   * It was, and that clipped the map's own content: two markers 55 km apart fit at a
   * scale above the ceiling, so the fallback re-centred on the *first* point and
   * pushed the second one off the bottom edge — a route map showing one end of the
   * route. Fitting to content has to honour the content; MAX_ZOOM exists to stop an
   * *explicit* zoom diving past the detail the geometry actually has, which is a
   * different question.
   *
   * The guard below is only for the degenerate case: points close enough to be
   * indistinguishable drive the scale toward infinity.
   */
  const fitted = projection.scale();
  const degenerate = scaleForZoom(DEGENERATE_ZOOM);
  if (!Number.isFinite(fitted) || fitted > degenerate) {
    const anchor = centroidOf(distinct);
    return projection
      .center([anchor.lng, anchor.lat])
      .scale(scaleForZoom(COINCIDENT_ZOOM))
      .translate([width / 2, height / 2]);
  }
  return projection;
}

/** Mean of a point set, used to centre a view that cannot be fitted. */
function centroidOf(points: Point[]): Point {
  const total = points.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: total.lat / points.length, lng: total.lng / points.length };
}

/**
 * Zoom ceiling, set by the *tile* layer rather than by the bundled geometry.
 *
 * It used to be 10, on the reasoning that 1:110m Natural Earth has no more detail
 * past that. That silently capped street-level requests: a map asking for z15 was
 * clamped to z10 and fetched city-scale tiles, so streets never appeared however far
 * in the caller zoomed. The vector basemap is the *fallback*; it must not dictate what
 * the primary surface can show. 19 is where tile providers stop.
 */
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 19;

/**
 * Where to sit when points are coincident and there is nothing to fit — a
 * neighbourhood view, which is a defensible guess. Not MAX_ZOOM: landing on a
 * building because two markers happened to match is worse than being slightly wide.
 */
const COINCIDENT_ZOOM = 12;

/**
 * Above this the points being fitted are effectively the same location and the scale
 * is running away. A divide-by-zero guard, not a detail limit.
 */
const DEGENERATE_ZOOM = 22;

export function clampZoom(zoom: unknown): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, finiteNumber(zoom, 4)));
}

/**
 * A scale bar whose length is a round number of kilometres rather than a round number
 * of pixels — the reverse reads as arbitrary.
 */
export function scaleBar(projection: GeoProjection, atY: number, maxPx = 120): { px: number; label: string } | null {
  const left = projection.invert?.([0, atY]);
  const right = projection.invert?.([maxPx, atY]);
  if (!left || !right) return null;

  const spanKm = geoDistance(left, right) * EARTH_RADIUS_KM;
  if (!Number.isFinite(spanKm) || spanKm <= 0) return null;

  const nice = niceDistance(spanKm);
  const px = (nice / spanKm) * maxPx;
  if (!Number.isFinite(px) || px <= 0) return null;
  return { px, label: formatDistance(nice) };
}

function niceDistance(km: number): number {
  const exponent = Math.floor(Math.log10(km));
  const magnitude = Math.pow(10, exponent);
  const normalized = km / magnitude;
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return step * magnitude;
}

export type LabelCandidate = { x: number; y: number; text: string; priority: number };
export type PlacedLabel = LabelCandidate;

/**
 * Greedy label placement, most important first, skipping any that would overlap
 * something already placed. Width is estimated from character count rather than
 * measured — measuring would need a live DOM and a reflow per label, and the estimate
 * only has to be good enough to reject collisions.
 *
 * Generic in the candidate so callers can tag each one (marker / city / country) and
 * filter the result. Every kind of label has to go through a *single* pass or they
 * collide with each other: three independent passes each avoid only their own kind.
 */
export function placeLabels<T extends LabelCandidate>(
  candidates: T[],
  options: { fontSize?: number; width?: number; height?: number } = {}
): T[] {
  const fontSize = options.fontSize ?? 11;
  const width = options.width ?? MAP_W;
  const height = options.height ?? MAP_H;
  const charWidth = fontSize * 0.55;
  // Boxes are kept for collision testing; the anchor is what callers draw at.
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  const placed: T[] = [];

  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority)) {
    const text = candidate.text.trim();
    if (!text) continue;
    const w = text.length * charWidth;
    const h = fontSize * 1.2;
    const box = { x: candidate.x - w / 2, y: candidate.y - h / 2, w, h };

    if (box.x < 0 || box.y < 0 || box.x + w > width || box.y + h > height) continue;
    const collides = boxes.some(
      (other) =>
        box.x < other.x + other.w &&
        box.x + w > other.x &&
        box.y < other.y + other.h &&
        box.y + h > other.y
    );
    if (collides) continue;

    boxes.push(box);
    placed.push(candidate);
  }

  return placed;
}

/**
 * Priority bands, so one placement pass can rank three kinds of label against each
 * other. Within a band the caller's own number breaks ties.
 *
 * Markers always win: they are what the answer is actually about. Between cities and
 * countries the order flips with zoom — a world view wants country names, a regional
 * view wants city names, and at that scale a country label is usually off-screen or
 * meaningless anyway.
 */
export const LABEL_BAND = {
  marker: 3e12,
  cityWhenZoomedIn: 2e12,
  countryWhenZoomedOut: 2e12,
  cityWhenZoomedOut: 1e12,
  countryWhenZoomedIn: 1e12
} as const;

/** Zoom at which city labels start outranking country labels. */
export const CITY_LABEL_ZOOM = 4;
