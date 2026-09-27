import { fetchLiveJson } from './fetch-allowlist.ts';

export type CurrencyConvertResult = {
  amount: number;
  from: string;
  to: string;
  rate: number;
  result: number;
  date?: string;
  source: string;
  rows: Array<{ label: string; value: string }>;
};

function normCurrency(code: string): string {
  return String(code || '').trim().toUpperCase();
}

export async function convertCurrency(params: {
  amount: number;
  from: string;
  to: string;
}): Promise<CurrencyConvertResult> {
  const amount = Number(params.amount);
  const from = normCurrency(params.from);
  const to = normCurrency(params.to);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid amount');
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw new Error('Currencies must be 3-letter ISO codes (e.g. USD, EUR)');
  }
  if (from === to) {
    return {
      amount,
      from,
      to,
      rate: 1,
      result: amount,
      date: new Date().toISOString().slice(0, 10),
      source: 'Frankfurter / ECB',
      rows: [
        { label: 'Amount', value: `${amount} ${from}` },
        { label: 'Rate', value: `1 ${from} = 1 ${to}` },
        { label: 'Result', value: `${amount} ${to}` }
      ]
    };
  }

  // Frankfurter v2 convert endpoint
  const url =
    `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  const data = (await fetchLiveJson(url)) as {
    amount?: number;
    base?: string;
    date?: string;
    rates?: Record<string, number>;
  };

  const rate = data.rates?.[to];
  if (rate == null || !Number.isFinite(rate)) {
    throw new Error(`No rate found for ${from} → ${to}`);
  }
  const result = amount * rate;
  const date = data.date;

  return {
    amount,
    from,
    to,
    rate,
    result,
    date,
    source: 'Frankfurter / ECB',
    rows: [
      { label: 'Amount', value: `${amount} ${from}` },
      { label: 'Rate', value: `1 ${from} = ${rate.toFixed(6)} ${to}` },
      { label: 'Result', value: `${result.toFixed(4)} ${to}` },
      ...(date ? [{ label: 'As of', value: date }] : [])
    ]
  };
}
