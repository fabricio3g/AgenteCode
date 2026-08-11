<svelte:options runes={true} />

<script lang="ts">
  import type { MapArtifactPayload } from '$lib/types/chat';
  import { geoPath, geoGraticule10, geoCentroid, geoArea } from 'd3-geo';
  import { loadAtlas, detailForZoom, type Atlas } from './map-atlas';
  import {
    MAP_W,
    MAP_H,
    MAP_PAD,
    clampZoom,
    cssColor,
    finiteNumber,
    fitProjection,
    formatDistance,
    lineLengthKm,
    normalizeLine,
    normalizePoint,
    placeLabels,
    scaleBar,
    strokeWidth,
    type Line,
    type Point
  } from './map-geo';

  interface Props {
    payload: MapArtifactPayload;
  }

  let { payload }: Props = $props();

  let atlas = $state<Atlas | null>(null);
  let atlasError = $state('');
  let activeMarker = $state<number | null>(null);

  const center = $derived<Point>({
    lat: finiteNumber(payload.latitude, 0),
    lng: finiteNumber(payload.longitude, 0)
  });
  const zoom = $derived(clampZoom(payload.zoom));
  const markers = $derived((payload.markers || []).map(normalizePoint).filter(Boolean) as Point[]);
  const lines = $derived((payload.polylines || []).map(normalizeLine).filter(Boolean) as Line[]);

  /*
   * Atlas loading mirrors ArtifactDiagram: a module-level cache, a cancellation flag,
   * and a visible loading state. The `loaded` latch is a plain `let`, not `$state` —
   * as `$state` it would be read and written inside its own effect, which
   * self-invalidates the effect and cancels the in-flight import before it resolves.
   * That exact mistake made diagrams render blank for the life of the feature.
   */
  let loadedDetail = '';
  $effect(() => {
    const detail = detailForZoom(zoom);
    if (detail === loadedDetail) return;
    loadedDetail = detail;
    let cancelled = false;

    loadAtlas(detail)
      .then((next) => {
        if (cancelled) return;
        atlas = next;
        atlasError = '';
      })
      .catch((err: unknown) => {
        // No `cancelled` guard on the error path: a genuine failure must surface even
        // if a newer load superseded this one.
        loadedDetail = '';
        atlasError = err instanceof Error ? err.message : String(err || 'Could not load map geometry');
      });

    return () => {
      cancelled = true;
    };
  });

  const projection = $derived(
    fitProjection({
      center,
      points: [...markers, ...lines.flatMap((line) => line.coords)],
      zoom
    })
  );
  const pathFor = $derived(geoPath(projection));
  const graticule = $derived(pathFor(geoGraticule10()) || '');
  const landPath = $derived(atlas ? pathFor(atlas.land) || '' : '');
  const bordersPath = $derived(atlas ? pathFor(atlas.borders) || '' : '');

  function project(point: Point): { x: number; y: number } | null {
    const xy = projection([point.lng, point.lat]);
    if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return null;
    return { x: xy[0], y: xy[1] };
  }

  const renderedMarkers = $derived(
    markers
      .map((point, index) => {
        const xy = project(point);
        return xy ? { ...point, ...xy, index } : null;
      })
      .filter(Boolean) as Array<Point & { x: number; y: number; index: number }>
  );

  const renderedLines = $derived(
    lines
      .map((line) => {
        const points = line.coords.map(project).filter(Boolean) as Array<{ x: number; y: number }>;
        if (points.length < 2) return null;
        return {
          ...line,
          points: points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
          km: lineLengthKm(line.coords)
        };
      })
      .filter(Boolean) as Array<Line & { points: string; km: number }>
  );

  /*
   * Country labels. Ranked by projected area so a world view names continents-worth of
   * countries and a regional view names the ones actually on screen; anything too small
   * to hold its own name is dropped before placement even runs.
   */
  const countryLabels = $derived.by(() => {
    if (!atlas) return [];
    const candidates: Array<{ x: number; y: number; text: string; priority: number }> = [];
    for (const country of atlas.countries) {
      const name = String((country.properties as { name?: string } | null)?.name || '');
      if (!name) continue;
      const centroid = geoCentroid(country as GeoJSON.Feature);
      const xy = projection(centroid);
      if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
      if (xy[0] < 0 || xy[1] < 0 || xy[0] > MAP_W || xy[1] > MAP_H) continue;
      const area = pathFor.area(country as GeoJSON.Feature);
      if (!Number.isFinite(area) || area < 900) continue;
      candidates.push({ x: xy[0], y: xy[1], text: name, priority: area });
    }
    return placeLabels(candidates, { fontSize: 10 });
  });

  const bar = $derived(scaleBar(projection, MAP_H - MAP_PAD));
  const legend = $derived(
    renderedLines
      .map((line, index) => ({
        color: line.color ? cssColor(line.color) : 'var(--primary)',
        label: line.label || `Route ${index + 1}`,
        distance: formatDistance(line.km)
      }))
      .slice(0, 4)
  );

  const active = $derived(
    activeMarker === null ? null : renderedMarkers.find((m) => m.index === activeMarker) || null
  );

  function toggleMarker(index: number) {
    activeMarker = activeMarker === index ? null : index;
  }
</script>

<div class="artifact-map">
  {#if payload.title}
    <div class="artifact-map-title">{payload.title}</div>
  {/if}

  <svg
    class="artifact-map-svg"
    width={MAP_W}
    height={MAP_H}
    viewBox="0 0 {MAP_W} {MAP_H}"
    role="img"
    aria-label={payload.title || 'Map'}
  >
    <path d={graticule} class="graticule" />

    {#if landPath}
      <path d={landPath} class="land" />
      <path d={bordersPath} class="borders" />
    {/if}

    {#each countryLabels as label}
      <text x={label.x} y={label.y} class="country-label">{label.text}</text>
    {/each}

    {#each renderedLines as line}
      <!--
        `stroke` comes from a CSS class, not from an attribute holding `var()`: SVG
        presentation attributes do not substitute custom properties, so a raw
        `stroke="var(--primary)"` is invalid and falls back to `none` — every
        default-coloured line was invisible. A model colour still wins, via a style.
      -->
      <polyline
        points={line.points}
        fill="none"
        class="map-line"
        style={line.color ? `stroke:${cssColor(line.color)}` : undefined}
        stroke-width={strokeWidth(line.weight)}
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {#if line.label}<title>{line.label} · {formatDistance(line.km)}</title>{/if}
      </polyline>
    {/each}

    {#each renderedMarkers as marker}
      <g
        transform={`translate(${marker.x}, ${marker.y})`}
        class="marker"
        class:active={activeMarker === marker.index}
        role="button"
        tabindex="0"
        aria-label={marker.label || `${marker.lat.toFixed(4)}, ${marker.lng.toFixed(4)}`}
        onclick={() => toggleMarker(marker.index)}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleMarker(marker.index);
          }
        }}
      >
        <circle r="9" class="marker-halo" />
        <circle r="5" class="marker-dot" />
        {#if marker.label}
          <text x="11" y="4">{marker.label}</text>
        {/if}
      </g>
    {/each}

    {#if bar}
      <g class="scale-bar" transform={`translate(${MAP_PAD}, ${MAP_H - 18})`}>
        <line x1="0" x2={bar.px} y1="0" y2="0" />
        <line x1="0" x2="0" y1="-4" y2="4" />
        <line x1={bar.px} x2={bar.px} y1="-4" y2="4" />
        <text x={bar.px + 7} y="4">{bar.label}</text>
      </g>
    {/if}
  </svg>

  {#if active}
    <!-- The payload has carried `popup` all along; it was only ever an SVG tooltip. -->
    <div class="map-popup">
      <span class="map-popup-title">{active.label || 'Marker'}</span>
      {#if active.popup}<span class="map-popup-body">{active.popup}</span>{/if}
      <span class="map-popup-coords">{active.lat.toFixed(4)}, {active.lng.toFixed(4)}</span>
    </div>
  {/if}

  {#if legend.length}
    <div class="map-legend">
      {#each legend as entry}
        <span class="legend-entry">
          <span class="legend-swatch" style={`background:${entry.color}`}></span>
          {entry.label}
          <span class="legend-distance">{entry.distance}</span>
        </span>
      {/each}
    </div>
  {/if}

  {#if !atlas && !atlasError}
    <p class="map-note">Loading map geometry…</p>
  {/if}
  {#if atlasError}
    <p class="map-note map-note-error">Coordinates only — {atlasError}</p>
  {/if}
</div>

<style>
  .artifact-map {
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.65rem;
    padding: 0.75rem 0.85rem;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
    color: var(--text);
  }

  .artifact-map-title {
    margin-bottom: 0.45rem;
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--text);
  }

  .artifact-map-svg {
    display: block;
    width: 100%;
    height: auto;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--chat-bg) 55%, transparent);
  }

  .graticule {
    fill: none;
    stroke: color-mix(in srgb, var(--text-muted) 16%, transparent);
    stroke-width: 0.5;
  }

  .land {
    fill: color-mix(in srgb, var(--text-muted) 16%, transparent);
    stroke: none;
  }

  .borders {
    fill: none;
    stroke: color-mix(in srgb, var(--text-muted) 42%, transparent);
    stroke-width: 0.6;
    stroke-linejoin: round;
  }

  .country-label {
    fill: var(--text-muted);
    font-size: 10px;
    font-weight: 500;
    text-anchor: middle;
    pointer-events: none;
  }

  .map-line {
    stroke: var(--primary);
    opacity: 0.9;
  }

  .marker {
    cursor: pointer;
  }

  .marker-halo {
    fill: color-mix(in srgb, var(--primary) 22%, transparent);
  }

  .marker.active .marker-halo {
    fill: color-mix(in srgb, var(--primary) 42%, transparent);
  }

  .marker-dot {
    fill: var(--primary);
  }

  .marker text {
    fill: var(--text);
    font-size: 12px;
    font-weight: 600;
    paint-order: stroke;
    stroke: var(--surface);
    stroke-width: 3px;
  }

  .scale-bar line {
    stroke: var(--text-secondary);
    stroke-width: 1.5;
  }

  .scale-bar text {
    fill: var(--text-secondary);
    font-size: 10px;
  }

  .map-popup {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    margin-top: 0.5rem;
    padding: 0.5rem 0.65rem;
    border-radius: var(--radius-sm);
    background: var(--surface-hover);
    font-size: 0.78rem;
  }

  .map-popup-title { font-weight: 650; }
  .map-popup-body { color: var(--text-secondary); }
  .map-popup-coords { color: var(--text-muted); font-size: 0.7rem; font-family: var(--font-mono); }

  .map-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    margin-top: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .legend-entry {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .legend-swatch {
    width: 12px;
    height: 3px;
    border-radius: 2px;
  }

  .legend-distance {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .map-note {
    margin: 0.4rem 0 0;
    color: var(--text-muted);
    font-size: 0.72rem;
  }

  .map-note-error { color: var(--error); }
</style>
