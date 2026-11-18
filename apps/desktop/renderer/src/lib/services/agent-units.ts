/**
 * Pure unit, date and time-zone conversion for the Home agent. No network, no
 * state: the model gets exact answers instead of doing the arithmetic itself.
 */

type Dimension = 'length' | 'mass' | 'volume' | 'speed' | 'data' | 'temperature';

/** Linear units: factor converts one unit to the dimension's base unit. */
const LINEAR: Record<Exclude<Dimension, 'temperature'>, Record<string, number>> = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 },
  mass: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318 },
  volume: { ml: 0.001, l: 1, m3: 1000, tsp: 0.00492892159375, tbsp: 0.01478676478125, floz: 0.0295735295625, cup: 0.2365882365, pt: 0.473176473, qt: 0.946352946, gal: 3.785411784 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 1852 / 3600, 'ft/s': 0.3048 },
  data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }
};

const ALIASES: Record<string, string> = {
  millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  inch: 'in', inches: 'in', '"': 'in', foot: 'ft', feet: 'ft', yard: 'yd', yards: 'yd',
  mile: 'mi', miles: 'mi', 'nautical mile': 'nmi', 'nautical miles': 'nmi',
  milligram: 'mg', milligrams: 'mg', gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  tonne: 't', tonnes: 't', ton: 't', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb', stone: 'st',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l', 'cubic meter': 'm3', 'cubic meters': 'm3', 'm^3': 'm3', 'm³': 'm3',
  teaspoon: 'tsp', teaspoons: 'tsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  'fluid ounce': 'floz', 'fluid ounces': 'floz', 'fl oz': 'floz', cups: 'cup', pint: 'pt', pints: 'pt',
  quart: 'qt', quarts: 'qt', gallon: 'gal', gallons: 'gal',
  kph: 'km/h', kmh: 'km/h', 'kilometers per hour': 'km/h', 'miles per hour': 'mph', knot: 'kn', knots: 'kn',
  'meters per second': 'm/s', mps: 'm/s', fps: 'ft/s',
  byte: 'b', bytes: 'b', kilobyte: 'kb', kilobytes: 'kb', megabyte: 'mb', megabytes: 'mb',
  gigabyte: 'gb', gigabytes: 'gb', terabyte: 'tb', terabytes: 'tb', petabyte: 'pb', petabytes: 'pb',
  celsius: 'c', centigrade: 'c', '°c': 'c', fahrenheit: 'f', '°f': 'f', kelvin: 'k'
};

const TEMPERATURE = new Set(['c', 'f', 'k']);

function normalizeUnit(raw: string): string {
  const key = String(raw || '').trim().toLowerCase();
  const direct = ALIASES[key] ?? key;
  // Case matters for nothing here except "L" vs "l", which lowercases to the same unit.
  return direct;
}

function dimensionOf(unit: string): Dimension | null {
  if (TEMPERATURE.has(unit)) return 'temperature';
  for (const dimension of Object.keys(LINEAR) as Array<keyof typeof LINEAR>) {
    if (unit in LINEAR[dimension]) return dimension;
  }
  return null;
}

function toKelvin(value: number, unit: string): number {
  if (unit === 'c') return value + 273.15;
  if (unit === 'f') return ((value - 32) * 5) / 9 + 273.15;
  return value;
}

function fromKelvin(value: number, unit: string): number {
  if (unit === 'c') return value - 273.15;
  if (unit === 'f') return ((value - 273.15) * 9) / 5 + 32;
  return value;
}

export type UnitConversion = { value: number; from: string; to: string; result: number; dimension: Dimension };

/** Convert within one dimension; throws a readable error for unknown or mismatched units. */
export function convertUnits(value: number, fromRaw: string, toRaw: string): UnitConversion {
  if (!Number.isFinite(value)) throw new Error('value must be a finite number');
  const from = normalizeUnit(fromRaw);
  const to = normalizeUnit(toRaw);
  const fromDim = dimensionOf(from);
  const toDim = dimensionOf(to);
  if (!fromDim) throw new Error(`Unknown unit: ${fromRaw}`);
  if (!toDim) throw new Error(`Unknown unit: ${toRaw}`);
  if (fromDim !== toDim) throw new Error(`Cannot convert ${fromDim} (${fromRaw}) to ${toDim} (${toRaw})`);
  let result: number;
  if (fromDim === 'temperature') {
    result = fromKelvin(toKelvin(value, from), to);
  } else {
    const table = LINEAR[fromDim];
    result = (value * table[from]) / table[to];
  }
  return { value, from, to, result: Number(result.toPrecision(12)), dimension: fromDim };
}

export function supportedUnits(): Record<string, string[]> {
  return {
    ...Object.fromEntries(Object.entries(LINEAR).map(([key, table]) => [key, Object.keys(table)])),
    temperature: ['c', 'f', 'k']
  };
}

function assertZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`Unknown time zone: ${zone} (use an IANA name such as America/New_York)`);
  }
}

/** Wall-clock parts of an instant in a zone. */
function zoneParts(date: Date, zone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** Offset of `zone` from UTC at `date`, in minutes. */
function zoneOffsetMinutes(date: Date, zone: string): number {
  const p = zoneParts(date, zone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Parse "2026-03-01 14:30" or "2026-03-01T14:30:00" as wall-clock time in `zone`,
 * or an ISO string with an explicit offset / Z as that instant.
 */
function parseInZone(input: string, zone: string): Date {
  const text = String(input || '').trim();
  if (!text) throw new Error('datetime is required');
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid datetime: ${input}`);
    return d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) throw new Error(`Invalid datetime: ${input} (use YYYY-MM-DD HH:mm or ISO 8601)`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  // Two passes settle the offset across DST boundaries.
  let guess = new Date(wall - zoneOffsetMinutes(new Date(wall), zone) * 60000);
  guess = new Date(wall - zoneOffsetMinutes(guess, zone) * 60000);
  return guess;
}

export type ZonedTime = { zone: string; iso: string; local: string; offset: string; weekday: string };

function describeInZone(date: Date, zone: string): ZonedTime {
  assertZone(zone);
  const p = zoneParts(date, zone);
  const offset = formatOffset(zoneOffsetMinutes(date, zone));
  const local = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  return {
    zone,
    iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`,
    local,
    offset,
    weekday: new Intl.DateTimeFormat('en', { timeZone: zone, weekday: 'long' }).format(date)
  };
}

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Convert a date-time between zones. `datetime` omitted means now. */
export function convertTimeZone(datetime: string | undefined, fromZone: string | undefined, toZones: string[]): { from: ZonedTime; to: ZonedTime[] } {
  const from = assertZone(fromZone || localZone());
  const instant = datetime ? parseInZone(datetime, from) : new Date();
  const targets = (toZones.length ? toZones : [localZone()]).map((zone) => describeInZone(instant, assertZone(zone)));
  return { from: describeInZone(instant, from), to: targets };
}

const DAY_MS = 86_400_000;

/** Difference between two dates, or a date shifted by days/hours/etc. */
export function dateMath(args: { start?: string; end?: string; add?: { years?: number; months?: number; weeks?: number; days?: number; hours?: number; minutes?: number }; zone?: string }): Record<string, unknown> {
  const zone = assertZone(args.zone || localZone());
  const start = args.start ? parseInZone(args.start, zone) : new Date();
  if (args.end) {
    const end = parseInZone(args.end, zone);
    const ms = end.getTime() - start.getTime();
    const abs = Math.abs(ms);
    return {
      start: describeInZone(start, zone).iso,
      end: describeInZone(end, zone).iso,
      totalDays: Number((ms / DAY_MS).toFixed(4)),
      totalHours: Number((ms / 3_600_000).toFixed(2)),
      breakdown: `${ms < 0 ? '-' : ''}${Math.floor(abs / DAY_MS)}d ${Math.floor((abs % DAY_MS) / 3_600_000)}h ${Math.floor((abs % 3_600_000) / 60_000)}m`
    };
  }
  const add = args.add || {};
  const shifted = new Date(start.getTime());
  // Calendar units move on the UTC calendar of the start instant; the clock units add exactly.
  shifted.setUTCFullYear(shifted.getUTCFullYear() + (add.years || 0));
  shifted.setUTCMonth(shifted.getUTCMonth() + (add.months || 0));
  const result = new Date(shifted.getTime() + ((add.weeks || 0) * 7 + (add.days || 0)) * DAY_MS + (add.hours || 0) * 3_600_000 + (add.minutes || 0) * 60_000);
  return { start: describeInZone(start, zone).iso, result: describeInZone(result, zone).iso, weekday: describeInZone(result, zone).weekday };
}
