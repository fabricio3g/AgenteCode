// ── Thinking levels from the shared core ───────────────────────────────
// Desktop does not decide which thinking levels a model has or what a level
// puts on the wire. The Rust core does, from the provider's TOML spec
// (crates/agente-core/providers/*.toml), models.dev, the provider's live model
// list (OpenRouter's `reasoning` object) and llama-server's `/props` — the
// same profile Agente Code's TUI shows. This module asks the daemon:
//
//   models.discover  {provider}               live list (once per provider)
//   models.thinking  {provider, model}        → ThinkingProfile
//   thinking.request {provider, model, level} → request fields to merge

import type { AgenteClient } from '../agente-client.ts';
import type { ReasoningCapabilities, ReasoningLevel, ReasoningRequest } from '../providers/base.ts';
import { capabilitiesFromProfile, UNKNOWN_CAPABILITIES, type ThinkingProfile } from './thinking-profile.ts';
import { loadConfig } from '../config.ts';
import { getLlamaStatus } from '../llm-runner.ts';
import { runtimeConnection, useProvider } from './rust-engine.ts';

/** A provider spec as `providers.list` sends it (crates/agente-core/providers/*.toml). */
export type ProviderSpec = {
  id: string;
  name: string;
  group: 'cloud' | 'local';
  base_url: string;
  api_format: string;
  aliases?: string[];
  key_url?: string | null;
  docs_url?: string | null;
  openai_compatible_url?: string | null;
  order: number;
  models: 'catalog' | 'openrouter' | 'openai_models' | 'llamacpp';
};

/** How long a resolved route (provider registered with the runtime) is reused. */
const ROUTE_TTL_MS = 60_000;

const routes = new Map<string, { at: number; route: Promise<{ id: string; model: string }> }>();
const discovered = new Map<string, Promise<void>>();
let specs: Promise<ProviderSpec[]> | null = null;

/** Register Desktop's provider with the runtime; reused for a minute. */
function route(client: AgenteClient, providerName: string, model: string): Promise<{ id: string; model: string }> {
  const key = `${providerName}\u0000${model}`;
  const cached = routes.get(key);
  if (cached && Date.now() - cached.at < ROUTE_TTL_MS) return cached.route;
  const next = useProvider(client, providerName, model);
  routes.set(key, { at: Date.now(), route: next });
  next.catch(() => routes.delete(key));
  return next;
}

function providerSpecs(client: AgenteClient): Promise<ProviderSpec[]> {
  specs ??= client
    .request<{ providers: ProviderSpec[] }>('providers.list')
    .then((result) => result.providers)
    .catch((error: unknown) => {
      specs = null;
      throw error;
    });
  return specs;
}

/**
 * Providers whose own model list carries thinking metadata (OpenRouter,
 * llama-server, …) are listed live once per runtime provider id, so the
 * profile reads the provider's answer rather than models.dev's copy.
 */
async function ensureDiscovered(client: AgenteClient, providerId: string): Promise<void> {
  const canonical = providerId.replace(/^desktop-/, '');
  const spec = (await providerSpecs(client)).find((s) => s.id === canonical || s.aliases?.includes(canonical));
  if (!spec || spec.models === 'catalog') return;
  // A llama-server can load another model at any time; /props is local and cheap.
  if (spec.models === 'llamacpp') discovered.delete(providerId);
  let pending = discovered.get(providerId);
  if (!pending) {
    pending = client.request('models.discover', { provider: providerId }).then(
      () => undefined,
      (error: unknown) => {
        discovered.delete(providerId);
        console.warn(`[thinking] ${providerId} model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    );
    discovered.set(providerId, pending);
  }
  await pending;
}

/** Every provider spec, in list order — the one provider directory. */
export async function listProviderSpecs(): Promise<ProviderSpec[]> {
  return providerSpecs(await runtimeConnection());
}

/** Forget live lists and routes (provider settings or the local model changed). */
export function resetThinkingCache(): void {
  routes.clear();
  discovered.clear();
  specs = null;
}

async function resolved(providerName: string, model: string): Promise<{ client: AgenteClient; id: string; model: string }> {
  const client = await runtimeConnection();
  const target = await route(client, providerName, model);
  await ensureDiscovered(client, target.id);
  return { client, ...target };
}

/**
 * A local model that is not loaded yet: judge the chat template llama-server
 * will render with (embedded, sidecar or family fallback — the same one
 * process-manager passes it) without launching it just to draw a selector.
 */
async function localTemplateCapabilities(client: AgenteClient): Promise<ReasoningCapabilities> {
  const local = (loadConfig().llm?.local ?? {}) as { selected_model_path?: string };
  const modelPath = local.selected_model_path;
  if (!modelPath) return UNKNOWN_CAPABILITIES;
  const { readGgufMetadataFields } = await import('../runtime-config-resolver.ts');
  const { resolveEffectiveTemplate } = await import('../chat-templates.ts');
  const fields = readGgufMetadataFields(modelPath);
  const { template } = resolveEffectiveTemplate({ modelPath, fields, ggufTemplate: fields?.chat_template ?? null });
  if (!template) return UNKNOWN_CAPABILITIES;
  return capabilitiesFromProfile(await client.request<ThinkingProfile>('thinking.template', { template }));
}

function llamaServing(): boolean {
  const status = getLlamaStatus() as { state?: string; port?: number | null };
  return status.state === 'ready' || (status.state === 'running' && !!status.port);
}

/** The thinking choices for a Desktop provider + model. */
export async function reasoningCapabilities(providerName: string, model: string): Promise<ReasoningCapabilities> {
  try {
    if (providerName === 'local' && !llamaServing()) {
      return await localTemplateCapabilities(await runtimeConnection());
    }
    const { client, id, model: modelId } = await resolved(providerName, model);
    const profile = await client.request<ThinkingProfile>('models.thinking', { provider: id, model: modelId });
    return capabilitiesFromProfile(profile);
  } catch (error) {
    console.warn(`[thinking] no profile for ${providerName}/${model}: ${error instanceof Error ? error.message : String(error)}`);
    return UNKNOWN_CAPABILITIES;
  }
}

/**
 * The reasoning request with the core's fields for its level attached.
 * Auto (no level) sends nothing; a core that cannot be reached sends nothing
 * rather than a guess.
 */
export async function withThinkingBody(
  providerName: string,
  model: string | undefined,
  reasoning: ReasoningRequest | null | undefined
): Promise<ReasoningRequest | undefined> {
  if (!reasoning?.level || reasoning.level === ('auto' as ReasoningLevel) || !model) return undefined;
  try {
    const { client, id, model: modelId } = await resolved(providerName, model);
    const { body } = await client.request<{ body: Record<string, unknown> }>('thinking.request', {
      provider: id,
      model: modelId,
      level: reasoning.level
    });
    return { ...reasoning, body };
  } catch (error) {
    console.warn(`[thinking] ${providerName}/${model} ${reasoning.level} not applied: ${error instanceof Error ? error.message : String(error)}`);
    return { ...reasoning, body: {} };
  }
}
