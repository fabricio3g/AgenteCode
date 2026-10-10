<svelte:options runes={true} />

<script lang="ts">
  import type { MapArtifactPayload } from '$lib/types/chat';
  import { geoPath, geoGraticule10, geoCentroid, geoArea } from 'd3-geo';
  import { appStore } from '$lib/stores/app.svelte';
  import { loadAtlas, detailForZoom, type Atlas } from './map-atlas';
  import {
    DEFAULT_TILE_TEMPLATE,
    OSM_ATTRIBUTION,
    tileUrl,
    tilesForViewport
  } from './map-tiles';
  import {
    MAP_DATA_ATTRIBUTION,
    citiesInView,
    cityDetailForZoom,
    formatPopulation,
    loadCities,
    type City
  } from './map-cities';
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
    CITY_LABEL_ZOOM,
    LABEL_BAND,
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
  let cities = $state<City[]>([]);
  let activeMarker = $state<number | null>(null);

  /*
   * Tiles are the default surface and the bundled geometry is the fallback, so the map
   * shows streets when there is a connection and still renders something real when
   * there is not. `tilesBroken` latches on the first tile that fails to load, which
   * covers the cases `navigator.onLine` misses: a captive portal, a blocked or
   * rate-limited tile host, a bad template.
   */
  let tilesBroken = $state(false);
  let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);

  $effect(() => {
    if (typeof window === 'undefined') return;
    const goOnline = () => {
      online = true;
      // Give tiles another chance once connectivity returns.
      tilesBroken = false;
    };
    const goOffline = () => { online = false; };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  });

  const tileConfig = $derived(appStore.config?.ui?.map_tiles ?? {});
  const tilesEnabled = $derived(tileConfig.enabled !== false);
  const tileTemplate = $derived(tileConfig.template || DEFAULT_TILE_TEMPLATE);
  const useTiles = $derived(tilesEnabled && online && !tilesBroken);

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

  let loadedCityDetail = '';
  $effect(() => {
    const detail = cityDetailForZoom(zoom);
    if (detail === loadedCityDetail) return;
    loadedCityDetail = detail;
    let cancelled = false;

    loadCities(detail)
      .then((next) => {
        if (!cancelled) cities = next;
      })
      .catch(() => {
        // Cities are an enhancement, not the map. A failure here leaves the geography,
        // the markers and the routes intact rather than blanking the artifact.
        loadedCityDetail = '';
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

  const tiles = $derived(
    useTiles ? tilesForViewport(projection, { width: MAP_W, height: MAP_H }) : []
  );

  /*
   * With tiles up, the vector layers are suppressed rather than drawn underneath: the
   * tile imagery already carries coastlines, borders, place names and — at street zoom
   * — the road grid, so drawing ours on top would double every label.
   */
  const showVectorBasemap = $derived(!tiles.length);

  const visibleCities = $derived(
    showVectorBasemap && cities.length ? citiesInView(cities, projection) : []
  );

  /*
   * One placement pass for every kind of label. Three separate passes would each avoid
   * only their own kind, so a city name would happily land on top of a country name.
   *
   * Marker labels are included as candidates purely to reserve their space — they are
   * drawn by the marker group itself, so they are filtered back out below.
   */
  const labels = $derived.by(() => {
    const zoomedIn = zoom >= CITY_LABEL_ZOOM;
    const candidates: Array<{ x: number; y: number; text: string; priority: number; kind: 'marker' | 'city' | 'country' }> = [];

    for (const marker of renderedMarkers) {
      if (!marker.label) continue;
      candidates.push({ x: marker.x, y: marker.y, text: marker.label, priority: LABEL_BAND.marker, kind: 'marker' });
    }

    for (const city of visibleCities) {
      candidates.push({
        x: city.x,
        y: city.y - 9,
        text: city.name,
        // Population breaks ties inside the band, so the biggest city wins the space.
        priority: (zoomedIn ? LABEL_BAND.cityWhenZoomedIn : LABEL_BAND.cityWhenZoomedOut) + city.population,
        kind: 'city'
      });
    }

    if (showVectorBasemap && atlas) {
      for (const country of atlas.countries) {
        const name = String((country.properties as { name?: string } | null)?.name || '');
        if (!name) continue;
        const centroid = geoCentroid(country as GeoJSON.Feature);
        const xy = projection(centroid);
        if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) continue;
        if (xy[0] < 0 || xy[1] < 0 || xy[0] > MAP_W || xy[1] > MAP_H) continue;
        // Too small to hold its own name — dropped before placement even runs.
        const area = pathFor.area(country as GeoJSON.Feature);
        if (!Number.isFinite(area) || area < 900) continue;
        candidates.push({
          x: xy[0],
          y: xy[1],
          text: name,
          priority: (zoomedIn ? LABEL_BAND.countryWhenZoomedIn : LABEL_BAND.countryWhenZoomedOut) + area,
          kind: 'country'
        });
      }
    }

    return placeLabels(candidates, { fontSize: 10 });
  });

  const cityLabels = $derived(labels.filter((label) => label.kind === 'city'));
  const countryLabels = $derived(labels.filter((label) => label.kind === 'country'));
  // Only cities whose name survived placement get a dot; an unlabelled dot is noise.
  const cityDots = $derived.by(() => {
    const named = new Set(cityLabels.map((label) => label.text));
    return visibleCities.filter((city) => named.has(city.name));
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

<div class="viz-surface artifact-map">
  {#if payload.title}
    <header class="viz-header"><h3 class="viz-title">{payload.title}</h3></header>
  {/if}

  <svg
    class="artifact-map-svg"
    width={MAP_W}
    height={MAP_H}
    viewBox="0 0 {MAP_W} {MAP_H}"
    role="img"
    aria-label={payload.title || 'Map'}
  >
    {#if showVectorBasemap}
      <path d={graticule} class="graticule" />
    {/if}

    {#each tiles as tile (tile.key)}
      <image
        href={tileUrl(tileTemplate, tile)}
        x={tile.sx}
        y={tile.sy}
        width={tile.sw}
        height={tile.sh}
        class="map-tile"
        preserveAspectRatio="none"
        onerror={() => (tilesBroken = true)}
      />
    {/each}

    {#if showVectorBasemap && landPath}
      <path d={landPath} class="land" />
      <path d={bordersPath} class="borders" />
    {/if}

    {#each countryLabels as label}
      <text x={label.x} y={label.y} class="country-label">{label.text}</text>
    {/each}

    {#each cityDots as city}
      <circle cx={city.x} cy={city.y} r="2.2" class="city-dot">
        <title>{city.name} · {formatPopulation(city.population)}</title>
      </circle>
    {/each}

    {#each cityLabels as label}
      <text x={label.x} y={label.y} class="city-label">{label.text}</text>
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

  {#if showVectorBasemap && !atlas && !atlasError}
    <p class="map-note">Loading map geometry…</p>
  {/if}
  {#if showVectorBasemap && atlasError}
    <p class="map-note map-note-error">Coordinates only — {atlasError}</p>
  {/if}
  {#if tilesEnabled && !useTiles}
    <!-- Says why the map looks different, rather than silently degrading. -->
    <p class="map-note">
      {online ? 'Map tiles unavailable' : 'Offline'} — showing the built-in basemap.
    </p>
  {/if}

  <!--
    Attribution is required, not decorative: OSM tiles are ODbL, and the bundled city
    data is GeoNames CC BY 4.0. It names whichever basemap is actually on screen.
  -->
  <p class="map-attribution">
    {center.lat.toFixed(3)}, {center.lng.toFixed(3)} · z{zoom} ·
    {showVectorBasemap ? MAP_DATA_ATTRIBUTION : OSM_ATTRIBUTION}
  </p>
</div>

<style>
  .artifact-map-svg {
    display: block;
    width: 100%;
    height: auto;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--chat-bg) 55%, transparent);
  }

  .map-tile {
    /* Tiles are cut to the projection, so any seam is a rounding artifact, not a gap.
       Nudging them a hair wider hides the hairlines between neighbours. */
    shape-rendering: optimizeSpeed;
    transform: scale(1.001);
    transform-origin: center;
    transform-box: fill-box;
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
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-anchor: middle;
    pointer-events: none;
  }

  .city-dot {
    fill: var(--text-secondary);
    opacity: 0.75;
  }

  /*
   * Cities read as places, countries as regions, so they are deliberately styled
   * apart: sentence case against uppercase, and a halo so a city name stays legible
   * where it crosses a border or a route.
   */
  .city-label {
    fill: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
    text-anchor: middle;
    paint-order: stroke;
    stroke: color-mix(in srgb, var(--chat-bg) 82%, transparent);
    stroke-width: 2.5px;
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
  }

  .map-popup {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    margin-top: 0.5rem;
    padding: 0.5rem 0.65rem;
    border-radius: var(--radius-sm);
    background: var(--surface-hover);
    font-size: var(--text-sm);
  }

  .map-popup-title { font-weight: 650; }
  .map-popup-body { color: var(--text-secondary); }
  .map-popup-coords { color: var(--text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }

  .map-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    margin-top: 0.5rem;
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
  }

  .map-note-error { color: var(--error); }

  .map-attribution {
    margin: 0.45rem 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
