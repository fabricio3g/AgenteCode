import { invoke, isElectron } from '$lib/services/bridge';

export type LiveInfoRows = Array<{ label: string; value: string; hint?: string }>;

export type LiveWeatherData = {
  place: string;
  rows: LiveInfoRows;
  source: string;
  asOf?: string;
  temperatureC?: number;
  conditions?: string;
};

export type LiveFxData = {
  amount: number;
  from: string;
  to: string;
  rate: number;
  result: number;
  date?: string;
  source: string;
  rows: LiveInfoRows;
};

export type LiveQuoteData = {
  symbol: string;
  price?: number;
  changePct?: number;
  source: string;
  rows: LiveInfoRows;
};

export type LiveGeocodeData = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  /** "City, Region, Country" — ready to use as a map title or marker label. */
  label: string;
};

type LiveResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Place name to coordinates. Runs in main against the existing host allowlist, and
 * only while a tool is executing — the resulting artifact stores plain coordinates,
 * so the map itself still renders with no network.
 */
export async function liveGeocodePlace(place: string): Promise<LiveGeocodeData> {
  if (!isElectron()) throw new Error('Geocoding requires the desktop app.');
  const res = await invoke<LiveResponse<LiveGeocodeData>>('live_geocode_place', { place });
  if (!res?.ok) throw new Error(res?.error || 'Geocoding failed');
  return res.data;
}

export async function liveGetWeather(location: string): Promise<LiveWeatherData> {
  if (!isElectron()) throw new Error('Live weather requires the desktop app.');
  const res = await invoke<LiveResponse<LiveWeatherData>>('live_get_weather', { location });
  if (!res?.ok) throw new Error(res?.error || 'Weather request failed');
  return res.data;
}

export async function liveConvertCurrency(amount: number, from: string, to: string): Promise<LiveFxData> {
  if (!isElectron()) throw new Error('Currency conversion requires the desktop app.');
  const res = await invoke<LiveResponse<LiveFxData>>('live_convert_currency', { amount, from, to });
  if (!res?.ok) throw new Error(res?.error || 'Currency conversion failed');
  return res.data;
}

export async function liveGetQuote(symbol: string): Promise<LiveQuoteData> {
  if (!isElectron()) throw new Error('Quotes require the desktop app.');
  const res = await invoke<LiveResponse<LiveQuoteData>>('live_get_quote', { symbol });
  if (!res?.ok) throw new Error(res?.error || 'Quote request failed');
  return res.data;
}
