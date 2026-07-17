/**
 * Network smoke test for open live-data APIs (Open-Meteo + Frankfurter).
 *   node scripts/smoke-live-data.mjs
 */

async function weatherMadrid() {
  const t0 = performance.now();
  const geo = await fetch(
    'https://geocoding-api.open-meteo.com/v1/search?name=Madrid&count=1&language=en&format=json'
  ).then((r) => r.json());
  const hit = geo.results?.[0];
  if (!hit) throw new Error('geocode failed');
  const wx = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
      '&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto'
  ).then((r) => r.json());
  const ms = performance.now() - t0;
  return {
    place: hit.name,
    temp: wx.current?.temperature_2m,
    wind: wx.current?.wind_speed_10m,
    ms: Math.round(ms)
  };
}

async function fxUsdEur() {
  const t0 = performance.now();
  const data = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR').then((r) =>
    r.json()
  );
  const rate = data.rates?.EUR;
  if (rate == null) throw new Error('fx failed');
  return {
    amount: 100,
    result: Number((100 * rate).toFixed(4)),
    rate,
    date: data.date,
    ms: Math.round(performance.now() - t0)
  };
}

const out = { ok: true, weather: null, fx: null, errors: [] };
try {
  out.weather = await weatherMadrid();
} catch (e) {
  out.ok = false;
  out.errors.push(`weather: ${e.message}`);
}
try {
  out.fx = await fxUsdEur();
} catch (e) {
  out.ok = false;
  out.errors.push(`fx: ${e.message}`);
}

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
