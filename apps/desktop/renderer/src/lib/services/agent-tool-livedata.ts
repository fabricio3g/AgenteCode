import type { ArtifactManifest } from '$lib/types/chat';
import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import { liveConvertCurrency, liveGetQuote, liveGetWeather } from '$lib/services/live-data';
import { handleCreateInfoCard } from '$lib/services/agent-tool-artifacts';

/*
 * These tools render as info cards, so they declare that themselves. They used to
 * publish an artifact inline via `buildArtifactFromContext(ctx)` — which read a
 * manifest off the shared context and so inherited whatever the previous artifact
 * tool left there, occasionally publishing a weather card as a chart. The tool loop
 * publishes from the returned result a moment later, so the inline call was
 * redundant as well as wrong.
 */
const INFO_CARD_MANIFEST = (entryPath: string): ArtifactManifest => ({
  schemaVersion: 1,
  kind: 'info_card',
  presentation: 'inline',
  entryPath,
  status: 'ready'
});

function writeChip(
  ctx: ToolContext,
  title: string,
  rows: Array<{ label: string; value: string }>,
  footer: string,
  accent: string,
  path: string,
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult,
  fail: (error: string, note?: string) => ToolResult
): ToolResult {
  return handleCreateInfoCard({
    args: { title, rows, footer, accent, path },
    ctx,
    normPath: (v) => String(v || path),
    ok,
    fail
  });
}

export async function handleGetWeather(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  try {
    const location = String(params.args.location || params.args.query || '').trim();
    if (!location) return params.fail('Missing location');
    const data = await liveGetWeather(location);
    const chip = writeChip(
      params.ctx,
      data.place || location,
      data.rows || [],
      `${data.source}${data.asOf ? ` · ${data.asOf}` : ''}`,
      'sky',
      'weather-card.json',
      params.ok,
      params.fail
    );
    if (!chip.success) return chip;
    return params.ok(
      { ...data, chip: true },
      { createdFiles: ['weather-card.json'], artifactManifest: INFO_CARD_MANIFEST('weather-card.json') }
    );
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleConvertCurrency(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  try {
    const amount = Number(params.args.amount);
    const from = String(params.args.from || params.args.source || '').trim();
    const to = String(params.args.to || params.args.target || '').trim();
    if (!Number.isFinite(amount)) return params.fail('Missing or invalid amount');
    if (!from || !to) return params.fail('Missing from/to currency codes (e.g. USD, EUR)');
    const data = await liveConvertCurrency(amount, from, to);
    const chip = writeChip(
      params.ctx,
      `${data.amount} ${data.from} → ${data.to}`,
      data.rows || [],
      data.source + (data.date ? ` · ${data.date}` : ''),
      'green',
      'fx-card.json',
      params.ok,
      params.fail
    );
    if (!chip.success) return chip;
    return params.ok(
      { ...data, chip: true },
      { createdFiles: ['fx-card.json'], artifactManifest: INFO_CARD_MANIFEST('fx-card.json') }
    );
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}

export async function handleGetQuote(params: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  ok: (output: unknown, extra?: Record<string, unknown>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
  failFromError: (err: unknown, note?: string) => ToolResult;
}): Promise<ToolResult> {
  try {
    const symbol = String(params.args.symbol || params.args.ticker || '').trim();
    if (!symbol) return params.fail('Missing symbol (e.g. AAPL, BTC)');
    const data = await liveGetQuote(symbol);
    const chip = writeChip(
      params.ctx,
      `${data.symbol} quote`,
      data.rows || [],
      data.source,
      'green',
      'quote-card.json',
      params.ok,
      params.fail
    );
    if (!chip.success) return chip;
    return params.ok(
      { ...data, chip: true },
      { createdFiles: ['quote-card.json'], artifactManifest: INFO_CARD_MANIFEST('quote-card.json') }
    );
  } catch (err: unknown) {
    return params.failFromError(err);
  }
}
