import { fetchLiveJson } from './fetch-allowlist.ts';

/**
 * Place name → coordinates, via the Open-Meteo geocoder.
 *
 * Extracted from `getWeather`, which had this inlined. The map artifact needs the same
 * lookup: without it the model has to run a web search just to find a latitude before
 * it can draw a map — which is exactly what happened in practice, and it then failed
 * the tool schema anyway.
 *
 * This runs in main, against the existing host allowlist, and only at *tool-execution*
 * time. The artifact stores plain coordinates, so the map itself still renders with no
 * network at all.
 */

export type GeocodeResult = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  /** Human-readable "City, Region, Country" for captions and marker labels. */
  label: string;
};

type GeocodeResponse = {
  results?: Array<{
    name?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
    admin1?: string;
  }>;
};

export async function geocodePlace(place: string): Promise<GeocodeResult> {
  const query = String(place || '').trim();
  if (!query) throw new Error('Missing place name');

  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const response = (await fetchLiveJson(url)) as GeocodeResponse;
  const hit = response.results?.[0];

  // `!hit.latitude` would reject the equator, and `!hit.longitude` the prime meridian.
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) {
    throw new Error(`Location not found: ${query}`);
  }

  const name = hit.name || query;
  return {
    name,
    latitude: hit.latitude as number,
    longitude: hit.longitude as number,
    country: hit.country,
    admin1: hit.admin1,
    label: [name, hit.admin1, hit.country].filter(Boolean).join(', ')
  };
}
