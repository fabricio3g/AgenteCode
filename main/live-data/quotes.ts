import { fetchLiveJson, fetchLiveText } from './fetch-allowlist.ts';

export type QuoteResult = {
  symbol: string;
  name?: string;
  price?: number;
  currency?: string;
  changePct?: number;
  dayHigh?: number;
  dayLow?: number;
  asOf?: string;
  source: string;
  rows: Array<{ label: string; value: string }>;
};

function normalizeSymbol(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^\$/, '')
    .replace(/\s+/g, '');
}

/** Stooq symbol: AAPL → aapl.us (US default), EURUSD → eurusd */
function toStooqSymbol(symbol: string): string {
  const s = symbol.toLowerCase();
  if (s.includes('.')) return s;
  if (/^[a-z]{6}$/.test(s) && !s.endsWith('us')) return s; // forex pair style
  if (s.endsWith('usd') && s.length <= 6) return s;
  // US equities default
  return `${s}.us`;
}

async function quoteFromStooq(symbol: string): Promise<QuoteResult | null> {
  const stooq = toStooqSymbol(symbol);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`;
  const text = await fetchLiveText(url);
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  // Header: Symbol,Date,Time,Open,High,Low,Close,Volume
  const cols = lines[1].split(',');
  if (cols.length < 7) return null;
  const close = Number(cols[6]);
  const open = Number(cols[3]);
  const high = Number(cols[4]);
  const low = Number(cols[5]);
  if (!Number.isFinite(close) || close <= 0) return null;
  const changePct = Number.isFinite(open) && open > 0 ? ((close - open) / open) * 100 : undefined;
  const date = cols[1];
  const time = cols[2];

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Symbol', value: symbol.toUpperCase() },
    { label: 'Price', value: String(close) },
    ...(changePct != null ? [{ label: 'Day change', value: `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` }] : []),
    ...(Number.isFinite(high) ? [{ label: 'High', value: String(high) }] : []),
    ...(Number.isFinite(low) ? [{ label: 'Low', value: String(low) }] : []),
    ...(date && date !== 'N/D' ? [{ label: 'As of', value: `${date}${time && time !== 'N/D' ? ` ${time}` : ''}` }] : [])
  ];

  return {
    symbol: symbol.toUpperCase(),
    price: close,
    changePct,
    dayHigh: Number.isFinite(high) ? high : undefined,
    dayLow: Number.isFinite(low) ? low : undefined,
    asOf: date !== 'N/D' ? date : undefined,
    source: 'Stooq',
    rows
  };
}

async function quoteFromCoinGecko(symbol: string): Promise<QuoteResult | null> {
  // Simple map for common tickers; CoinGecko uses ids not tickers.
  const map: Record<string, string> = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    DOGE: 'dogecoin',
    XRP: 'ripple',
    ADA: 'cardano',
    DOT: 'polkadot',
    AVAX: 'avalanche-2'
  };
  const id = map[symbol.toUpperCase()];
  if (!id) return null;
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}` +
    `&vs_currencies=usd&include_24hr_change=true`;
  const data = (await fetchLiveJson(url)) as Record<string, { usd?: number; usd_24h_change?: number }>;
  const entry = data[id];
  if (!entry?.usd) return null;
  const change = entry.usd_24h_change;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Asset', value: symbol.toUpperCase() },
    { label: 'Price', value: `$${entry.usd}` },
    ...(change != null
      ? [{ label: '24h change', value: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` }]
      : [])
  ];
  return {
    symbol: symbol.toUpperCase(),
    price: entry.usd,
    currency: 'USD',
    changePct: change,
    source: 'CoinGecko',
    rows
  };
}

export async function getQuote(symbolRaw: string): Promise<QuoteResult> {
  const symbol = normalizeSymbol(symbolRaw);
  if (!symbol || symbol.length > 16) throw new Error('Invalid symbol');

  // Crypto first for known coins
  const crypto = await quoteFromCoinGecko(symbol).catch(() => null);
  if (crypto) return crypto;

  const stooq = await quoteFromStooq(symbol).catch(() => null);
  if (stooq) return stooq;

  throw new Error(`Could not fetch quote for ${symbol}`);
}
