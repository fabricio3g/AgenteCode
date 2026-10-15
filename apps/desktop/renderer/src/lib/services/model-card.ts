import { invoke, isElectron } from '$lib/services/bridge';

/** What the model picker's card says about a cloud model. Unknown numbers are null. */
export interface ModelCard {
  context: number | null;
  output: number | null;
  /** Dollars per million tokens. */
  cost: { input: number | null; output: number | null; cacheRead: number | null } | null;
  /** `text`, `image`, `audio`, `video`, `pdf` (or `file`). Empty = unknown. */
  inputs: string[];
  tools: boolean;
  reasoning: boolean;
}

const cards = new Map<string, Promise<ModelCard | null>>();

/** One request per model for the life of the window; a failure is not cached. */
export function getModelCard(provider: string, model: string): Promise<ModelCard | null> {
  if (!isElectron() || !provider || !model) return Promise.resolve(null);
  const key = `${provider}\0${model}`;
  let pending = cards.get(key);
  if (!pending) {
    pending = invoke<ModelCard>('get_model_card', { providerName: provider, model }).catch(() => {
      cards.delete(key);
      return null;
    });
    cards.set(key, pending);
  }
  return pending;
}

/** `128k`, `1M`: a window or output cap as people say it. */
export function formatTokens(value: number | null | undefined): string {
  if (!value) return '';
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1024)}k`;
}

/** `$0.60`, `$0.014`, `gratis` when the provider charges nothing. */
export function formatPrice(value: number | null | undefined, free: string): string {
  if (value == null) return '';
  if (value === 0) return free;
  return `$${value < 0.1 ? value.toFixed(3).replace(/0+$/, '') : value.toFixed(2)}`;
}
