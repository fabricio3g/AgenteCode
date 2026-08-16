/**
 * Bundled world geometry for the map artifact.
 *
 * Natural Earth via `world-atlas`, converted from TopoJSON at load time. Two levels of
 * detail, both dynamically imported so neither lands in the main bundle:
 *
 *   countries-110m  ~105 kB  world and continental views
 *   countries-50m   ~738 kB  regional and tighter, where 110m visibly coarsens
 *
 * This is deliberately *not* a tile basemap. It ships with the app, so the map renders
 * with no network at all — which is what lets the artifact keep the determinism promise
 * the rest of the artifact pipeline makes (see `preview-builder.ts`).
 */

import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';

export type AtlasDetail = '110m' | '50m';

export type Atlas = {
  detail: AtlasDetail;
  /** Landmass outline, drawn as fill. */
  land: GeoJSON.FeatureCollection;
  /** Interior borders only, so shared borders are not drawn twice. */
  borders: GeoJSON.MultiLineString;
  /** Individual countries, for labelling. */
  countries: GeoJSON.Feature[];
};

type CountriesTopology = Topology<{ countries: GeometryCollection<{ name?: string }> }>;

const cache = new Map<AtlasDetail, Promise<Atlas>>();

/** 50m is worth its extra ~630 kB only once the view is regional. */
export function detailForZoom(zoom: number): AtlasDetail {
  return zoom >= 5 ? '50m' : '110m';
}

async function importTopology(detail: AtlasDetail): Promise<CountriesTopology> {
  const loaded =
    detail === '50m'
      ? await import('world-atlas/countries-50m.json')
      : await import('world-atlas/countries-110m.json');
  return ((loaded as { default?: unknown }).default ?? loaded) as unknown as CountriesTopology;
}

export function loadAtlas(detail: AtlasDetail): Promise<Atlas> {
  const cached = cache.get(detail);
  if (cached) return cached;

  const pending = (async (): Promise<Atlas> => {
    const topology = await importTopology(detail);
    const collection = topology.objects.countries;
    const countries = feature(topology, collection) as unknown as GeoJSON.FeatureCollection;
    return {
      detail,
      land: countries,
      // `a !== b` yields interior borders only; passing no filter would draw every
      // country outline, doubling every shared border.
      borders: mesh(topology, collection, (a, b) => a !== b) as GeoJSON.MultiLineString,
      countries: countries.features
    };
  })();

  cache.set(detail, pending);
  // A failed import must not poison the cache — the next map should retry.
  pending.catch(() => cache.delete(detail));
  return pending;
}
