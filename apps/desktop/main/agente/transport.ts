import type { LocalModelSelection } from '../../shared/agente-protocol.ts';
// ── Which endpoint a Code chat talks to ────────────────────────────────
// A chat names a provider and model; this resolves them against Desktop's
// config into the endpoint the Rust runtime is configured with, and answers
// the questions the UI asks about it (does it see images, how big is its
// context window).

import path from 'node:path';
import { loadConfigFromDisk } from '../config.ts';
import { resolveApiKey } from '../provider-auth.ts';
import { resolveProvider } from '../providers/registry.ts';
import { isVisionModel } from '../../shared/model-capabilities.ts';
import { DEFAULT_PROVIDER_BASE_URL } from '../../shared/providers.ts';

/** Assumed context window when the provider cannot tell us. */
const FALLBACK_CONTEXT_WINDOW = 32_768;

export interface AgenteTransport {
  providerName: string;
  baseUrl: string;
  model: string;
  modelPath?: string;
}

type LlmConfig = { backend_mode?: string; local?: Record<string, any>; providers?: Record<string, Record<string, any>> };

function llmConfig(): LlmConfig {
  return (loadConfigFromDisk() as { llm?: LlmConfig }).llm ?? {};
}

function localBaseUrl(local: Record<string, any>): string {
  const port = Number(local.port) || 11435;
  const url = new URL(local.base_url || `http://127.0.0.1:${port}/v1`);
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/+$/, '').replace(/(?:\/v1)?$/, '/v1');
}

function localTransport(local: Record<string, any>, model?: string): AgenteTransport {
  const selected = local.selected_model_path ? path.basename(local.selected_model_path) : '';
  return { providerName: 'local', baseUrl: localBaseUrl(local), model: model || local.model || selected, modelPath: local.selected_model_path };
}

function apiTransport(providerName: string, provider: Record<string, any>, model?: string): AgenteTransport {
  return { providerName, baseUrl: provider.base_url || DEFAULT_PROVIDER_BASE_URL, model: model || provider.model || '' };
}

/** Local when asked for, or when no model is named and Desktop runs locally. */
function usesLocal(llm: LlmConfig, providerName: string, modelOverride?: string): boolean {
  return providerName === 'local' || (!modelOverride && llm.backend_mode === 'local');
}

export function resolveTransport(providerName: string, modelOverride?: string, selection?: LocalModelSelection): AgenteTransport {
  const llm = llmConfig();
  if (usesLocal(llm, providerName, modelOverride)) return localTransport({ ...llm.local, ...(selection ? { selected_model_path: selection.modelPath, base_url: selection.baseUrl || llm.local?.base_url } : {}) }, modelOverride);
  return apiTransport(providerName, llm.providers?.[providerName] ?? {}, modelOverride);
}

/** Local models see images only with a vision projector loaded; API models by id. */
export function transportSeesImages(transport: AgenteTransport): boolean {
  if (transport.providerName === 'local') {
    const cfg = loadConfigFromDisk() as { llm?: { local?: { mmproj_path?: string } } };
    return !!cfg.llm?.local?.mmproj_path;
  }
  return isVisionModel(transport.model);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** What the provider says about the model, or null when it can't be asked. */
async function providerContextWindow(transport: AgenteTransport): Promise<number | null> {
  const apiKey = resolveApiKey('', transport.baseUrl, transport.providerName);
  if (!apiKey) return null;
  const provider = resolveProvider(transport.providerName, transport.baseUrl);
  const metadata = await withTimeout(provider.fetchModelMetadata(apiKey, transport.baseUrl, transport.model), 5000);
  return positive((metadata as { context_window?: number } | null)?.context_window);
}

/**
 * The active model's context window: local runtime config first, then a
 * provider metadata lookup, then a conservative fallback.
 */
export async function resolveContextWindow(transport: AgenteTransport): Promise<number> {
  if (transport.providerName === 'local') return positive(llmConfig().local?.context_length) ?? FALLBACK_CONTEXT_WINDOW;
  // Metadata is best-effort.
  return (await providerContextWindow(transport).catch(() => null)) ?? FALLBACK_CONTEXT_WINDOW;
}
