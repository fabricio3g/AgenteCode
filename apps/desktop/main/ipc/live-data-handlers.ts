import type { IpcMain } from 'electron';
import { getWeather } from '../live-data/weather.ts';
import { convertCurrency } from '../live-data/fx.ts';
import { getQuote } from '../live-data/quotes.ts';
import { geocodePlace } from '../live-data/geocode.ts';
import type { ErrorMessageFn } from './types.ts';

export function registerLiveDataHandlers(params: {
  ipcMain: IpcMain;
  toErrorMessage: ErrorMessageFn;
}): void {
  const { ipcMain, toErrorMessage } = params;

  ipcMain.handle('live_get_weather', async (_e, args: { location?: string }) => {
    try {
      return { ok: true, data: await getWeather(String(args?.location || '')) };
    } catch (err: unknown) {
      return { ok: false, error: toErrorMessage(err) };
    }
  });

  ipcMain.handle('live_convert_currency', async (_e, args: { amount?: number; from?: string; to?: string }) => {
    try {
      return {
        ok: true,
        data: await convertCurrency({
          amount: Number(args?.amount),
          from: String(args?.from || ''),
          to: String(args?.to || '')
        })
      };
    } catch (err: unknown) {
      return { ok: false, error: toErrorMessage(err) };
    }
  });

  // Used by create_map so a model can say "Victoria, Entre Rios" instead of hunting
  // for coordinates. Resolved here, at tool-execution time; the artifact stores plain
  // coordinates and still renders offline.
  ipcMain.handle('live_geocode_place', async (_e, args: { place?: string }) => {
    try {
      return { ok: true, data: await geocodePlace(String(args?.place || '')) };
    } catch (err: unknown) {
      return { ok: false, error: toErrorMessage(err) };
    }
  });

  ipcMain.handle('live_get_quote', async (_e, args: { symbol?: string }) => {
    try {
      return { ok: true, data: await getQuote(String(args?.symbol || '')) };
    } catch (err: unknown) {
      return { ok: false, error: toErrorMessage(err) };
    }
  });
}
