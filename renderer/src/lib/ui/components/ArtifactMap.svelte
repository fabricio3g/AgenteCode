<svelte:options runes={true} />

<script lang="ts">
  import type { MapArtifactPayload } from '$lib/types/chat';

  interface Props {
    payload: MapArtifactPayload;
  }

  let { payload }: Props = $props();

  const W = 720;
  const H = 420;
  const PAD = 42;

  type Point = { lat: number; lng: number; label?: string; popup?: string };
  type Line = { coords: Point[]; color?: string; weight?: number; label?: string };

  function finiteNumber(value: unknown, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizePoint(point: { lat?: number; lng?: number; label?: string; popup?: string } | null | undefined): Point | null {
    if (!point) return null;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      label: point.label,
      popup: point.popup
    };
  }

  function normalizeLine(line: MapArtifactPayload['polylines'][number]): Line | null {
    if (Array.isArray(line)) {
      const coords = line.map(normalizePoint).filter(Boolean) as Point[];
      return coords.length > 1 ? { coords } : null;
    }
    const coords = (Array.isArray(line.coords) ? line.coords : []).map(normalizePoint).filter(Boolean) as Point[];
    return coords.length > 1
      ? { coords, color: line.color, weight: line.weight, label: line.label }
      : null;
  }

  function mercator(lat: number, lng: number) {
    const safeLat = Math.max(-85, Math.min(85, lat));
    const rad = safeLat * Math.PI / 180;
    return {
      x: (lng + 180) / 360,
      y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
    };
  }

  const center = $derived({
    lat: finiteNumber(payload.latitude, 0),
    lng: finiteNumber(payload.longitude, 0)
  });
  const zoom = $derived(Math.max(1, Math.min(18, Math.round(finiteNumber(payload.zoom, 8)))));
  const markers = $derived((payload.markers || []).map(normalizePoint).filter(Boolean) as Point[]);
  const lines = $derived((payload.polylines || []).map(normalizeLine).filter(Boolean) as Line[]);
  const allPoints = $derived([center, ...markers, ...lines.flatMap((line) => line.coords)]);

  const bounds = $derived.by(() => {
    const projected = allPoints.map((point) => mercator(point.lat, point.lng));
    const centerProjected = mercator(center.lat, center.lng);
    const zoomSpan = Math.max(0.0015, 1 / Math.pow(2, zoom + 1));
    let minX = centerProjected.x - zoomSpan;
    let maxX = centerProjected.x + zoomSpan;
    let minY = centerProjected.y - zoomSpan;
    let maxY = centerProjected.y + zoomSpan;

    for (const point of projected) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    const dx = Math.max(maxX - minX, 0.0008);
    const dy = Math.max(maxY - minY, 0.0008);
    return {
      minX: minX - dx * 0.12,
      maxX: maxX + dx * 0.12,
      minY: minY - dy * 0.12,
      maxY: maxY + dy * 0.12
    };
  });

  function toSvg(point: Point) {
    const projected = mercator(point.lat, point.lng);
    const x = PAD + ((projected.x - bounds.minX) / (bounds.maxX - bounds.minX)) * (W - PAD * 2);
    const y = PAD + ((projected.y - bounds.minY) / (bounds.maxY - bounds.minY)) * (H - PAD * 2);
    return { x, y };
  }

  const renderedMarkers = $derived(markers.map((point) => ({ ...point, ...toSvg(point) })));
  const renderedLines = $derived(lines.map((line) => ({
    ...line,
    points: line.coords.map((point) => {
      const projected = toSvg(point);
      return `${projected.x.toFixed(2)},${projected.y.toFixed(2)}`;
    }).join(' ')
  })));
  const centerPoint = $derived(toSvg(center));
  const grid = [0.2, 0.4, 0.6, 0.8];
</script>

<div class="artifact-map">
  {#if payload.title}
    <div class="artifact-map-title">{payload.title}</div>
  {/if}
  <svg class="artifact-map-svg" viewBox="0 0 {W} {H}" role="img" aria-label={payload.title || 'Map'}>
    {#each grid as ratio}
      <line x1={PAD} x2={W - PAD} y1={PAD + (H - PAD * 2) * ratio} y2={PAD + (H - PAD * 2) * ratio} class="grid-line" />
      <line y1={PAD} y2={H - PAD} x1={PAD + (W - PAD * 2) * ratio} x2={PAD + (W - PAD * 2) * ratio} class="grid-line" />
    {/each}

    {#each renderedLines as line}
      <polyline
        points={line.points}
        fill="none"
        stroke={line.color || 'var(--primary)'}
        stroke-width={Math.max(1.5, Number(line.weight || 3))}
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.86"
      >
        {#if line.label}<title>{line.label}</title>{/if}
      </polyline>
    {/each}

    <circle cx={centerPoint.x} cy={centerPoint.y} r="7" class="center-dot">
      <title>Center: {center.lat.toFixed(5)}, {center.lng.toFixed(5)}</title>
    </circle>

    {#each renderedMarkers as marker}
      <g transform={`translate(${marker.x}, ${marker.y})`} class="marker">
        <circle r="9" class="marker-halo" />
        <circle r="5" class="marker-dot" />
        <title>{marker.popup || marker.label || `${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)}`}</title>
        {#if marker.label}
          <text x="11" y="4">{marker.label}</text>
        {/if}
      </g>
    {/each}

    <text x={PAD} y={H - 12} class="coordinate-label">
      {center.lat.toFixed(4)}, {center.lng.toFixed(4)} · z{zoom} · deterministic local map
    </text>
  </svg>
</div>

<style>
  .artifact-map {
    width: min(100%, 42rem);
    margin-top: 0.65rem;
    color: var(--text);
  }

  .artifact-map-title {
    margin-bottom: 0.4rem;
    font-size: 0.95rem;
    font-weight: 650;
  }

  .artifact-map-svg {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
    background:
      radial-gradient(circle at 28% 22%, color-mix(in srgb, var(--primary) 14%, transparent), transparent 32%),
      linear-gradient(180deg, color-mix(in srgb, var(--surface) 35%, transparent), transparent);
  }

  .grid-line {
    stroke: color-mix(in srgb, var(--text-muted) 22%, transparent);
    stroke-dasharray: 5 8;
  }

  .center-dot {
    fill: color-mix(in srgb, var(--text) 50%, transparent);
    stroke: var(--surface);
    stroke-width: 2;
  }

  .marker-halo {
    fill: color-mix(in srgb, var(--primary) 22%, transparent);
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

  .coordinate-label {
    fill: var(--text-muted);
    font-size: 11px;
  }
</style>
