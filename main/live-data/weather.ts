import { fetchLiveJson } from './fetch-allowlist.ts';

const WMO: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail'
};

export type WeatherResult = {
  place: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  temperatureC?: number;
  feelsLikeC?: number;
  humidityPct?: number;
  windKmh?: number;
  conditions?: string;
  highC?: number;
  lowC?: number;
  asOf?: string;
  source: string;
  rows: Array<{ label: string; value: string }>;
};

export async function getWeather(location: string): Promise<WeatherResult> {
  const q = String(location || '').trim();
  if (!q) throw new Error('Missing location');

  const geoUrl =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
  const geo = (await fetchLiveJson(geoUrl)) as {
    results?: Array<{
      name?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
      timezone?: string;
      admin1?: string;
    }>;
  };
  const hit = geo.results?.[0];
  if (!hit?.latitude || !hit?.longitude) {
    throw new Error(`Location not found: ${q}`);
  }

  const lat = hit.latitude;
  const lon = hit.longitude;
  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;

  const wx = (await fetchLiveJson(weatherUrl)) as {
    timezone?: string;
    current?: {
      time?: string;
      temperature_2m?: number;
      relative_humidity_2m?: number;
      apparent_temperature?: number;
      weather_code?: number;
      wind_speed_10m?: number;
    };
    daily?: {
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
    };
  };

  const current = wx.current || {};
  const code = Number(current.weather_code);
  const conditions = WMO[code] || (Number.isFinite(code) ? `Code ${code}` : 'Unknown');
  const place = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Conditions', value: conditions },
    ...(current.temperature_2m != null
      ? [{ label: 'Temperature', value: `${Number(current.temperature_2m).toFixed(1)}°C` }]
      : []),
    ...(current.apparent_temperature != null
      ? [{ label: 'Feels like', value: `${Number(current.apparent_temperature).toFixed(1)}°C` }]
      : []),
    ...(current.relative_humidity_2m != null
      ? [{ label: 'Humidity', value: `${current.relative_humidity_2m}%` }]
      : []),
    ...(current.wind_speed_10m != null
      ? [{ label: 'Wind', value: `${Number(current.wind_speed_10m).toFixed(1)} km/h` }]
      : []),
    ...(wx.daily?.temperature_2m_max?.[0] != null
      ? [{ label: 'High today', value: `${Number(wx.daily.temperature_2m_max[0]).toFixed(1)}°C` }]
      : []),
    ...(wx.daily?.temperature_2m_min?.[0] != null
      ? [{ label: 'Low today', value: `${Number(wx.daily.temperature_2m_min[0]).toFixed(1)}°C` }]
      : [])
  ];

  return {
    place: place || q,
    country: hit.country,
    latitude: lat,
    longitude: lon,
    timezone: wx.timezone || hit.timezone,
    temperatureC: current.temperature_2m,
    feelsLikeC: current.apparent_temperature,
    humidityPct: current.relative_humidity_2m,
    windKmh: current.wind_speed_10m,
    conditions,
    highC: wx.daily?.temperature_2m_max?.[0],
    lowC: wx.daily?.temperature_2m_min?.[0],
    asOf: current.time,
    source: 'Open-Meteo',
    rows
  };
}
