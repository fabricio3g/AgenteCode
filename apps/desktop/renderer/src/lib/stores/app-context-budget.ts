import type { RequestMessage } from '$lib/services/chat/types';
import type { ContextBreakdown } from '$shared/agente-protocol';

export interface ContextBudgetValue {
  estimated?: boolean;
  /** Preview estimates; omitted when the runtime only reports a total. */
  breakdown?: ContextBreakdown;
  maxContext: number;
  usedTokens: number;
  remaining: number;
  usagePercent: number;
  isOverflow: boolean;
  reservedForCompletion: number;
  promptCostPerMillionUsd?: number;
  completionCostPerMillionUsd?: number;
}

export interface ApiModelMetadataValue {
  context_window: number;
  max_completion_tokens?: number;
  prompt_cost_per_million?: number;
  completion_cost_per_million?: number;
}

export type InvokeFn = <T = unknown>(channel: string, payload?: unknown) => Promise<T>;

function normalizeLocalContextBudget(input: unknown): ContextBudgetValue | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<ContextBudgetValue>;
  return {
    maxContext: Number(value.maxContext) || 4096,
    usedTokens: Math.max(0, Number(value.usedTokens) || 0),
    remaining: Math.max(0, Number(value.remaining) || 0),
    usagePercent: Math.min(100, Math.max(0, Number(value.usagePercent) || 0)),
    isOverflow: Boolean(value.isOverflow),
    reservedForCompletion: Math.max(0, Number(value.reservedForCompletion) || 0)
  };
}

async function countMessageTokens(messages: RequestMessage[], invoke: InvokeFn): Promise<number> {
  let totalTokens = 0;
  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const tokens = await invoke<number>('count_tokens', { text });
    totalTokens += typeof tokens === 'number' ? tokens : 0;
  }
  return totalTokens;
}

export function buildApiContextBudget(params: {
  totalTokens: number;
  contextWindow: number;
  providerMaxTokens?: number;
  modelMetadata: ApiModelMetadataValue;
}): ContextBudgetValue {
  const maxTokensSetting = params.providerMaxTokens
    || params.modelMetadata.max_completion_tokens
    || Math.floor(params.contextWindow * 0.1);
  const reserved = Math.min(maxTokensSetting, Math.floor(params.contextWindow * 0.2));
  const effectiveMax = params.contextWindow - reserved;
  const usagePercent = Math.min(100, Math.round((params.totalTokens / params.contextWindow) * 100));
  const remaining = Math.max(0, effectiveMax - params.totalTokens);

  const promptCostPerMillionUsd = params.modelMetadata.prompt_cost_per_million;
  const completionCostPerMillionUsd = params.modelMetadata.completion_cost_per_million;

  return {
    maxContext: params.contextWindow,
    usedTokens: params.totalTokens,
    remaining,
    usagePercent,
    isOverflow: params.totalTokens > effectiveMax,
    reservedForCompletion: reserved,
    promptCostPerMillionUsd,
    completionCostPerMillionUsd
  };
}

export function estimateTokensFromMessages(messages: RequestMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    total += 4 + Math.ceil(content.length / 4);
    const reasoning = (msg as RequestMessage & { reasoning?: string }).reasoning;
    if (reasoning) total += Math.ceil(String(reasoning).length / 4);
  }
  return total;
}

/** Estimate the supplied request by role; tools and runtime additions are not included. */
export function estimateContextBreakdown(messages: RequestMessage[]): { system: number; messages: number } {
  return {
    system: estimateTokensFromMessages(messages.filter((message) => message.role === 'system')),
    messages: estimateTokensFromMessages(messages.filter((message) => message.role !== 'system'))
  };
}

export function inferContextWindowFromModel(providerName?: string, modelId?: string): number | null {
  const provider = String(providerName || '').toLowerCase();
  const model = String(modelId || '').toLowerCase();
  if (!model) return null;

  // Strip OpenRouter variant suffixes for matching (e.g. :free)
  const bare = model.replace(/:.*$/, '');

  if (provider.includes('anthropic') || bare.includes('claude')) {
    if (bare.includes('instant')) return 100_000;
    return 200_000;
  }

  if (provider.includes('gemini') || bare.includes('gemini')) {
    // Gemini 1.5 / 2.x / 3.x long-context series
    if (/gemini-(?:1\.5|2\.|2-|3|flash|pro)/.test(bare)) return 1_000_000;
    return 32_768;
  }

  if (bare.includes('gemma')) {
    // Gemma 2/3/4 common hosted sizes
    if (/gemma-?4|gemma-3|gemma2|gemma-2/.test(bare)) return 128_000;
    return 32_768;
  }

  // OpenAI GPT-5 / o-series / GPT-4.x
  if (/gpt-5|gpt5/.test(bare)) return 400_000;
  if (bare.includes('gpt-4.1') || bare.includes('gpt-4o') || bare.includes('gpt-4-turbo') || /o[134]\b/.test(bare)) {
    return 128_000;
  }
  if (bare.includes('gpt-4-32k')) return 32_768;
  if (bare.includes('gpt-4')) return 8_192;
  if (bare.includes('gpt-3.5-turbo')) return 16_384;
  if (bare.includes('gpt-3.5')) return 4_096;

  // DeepSeek — V4 is 1M context on official API
  if (provider.includes('deepseek') || bare.includes('deepseek')) {
    if (/v4|deepseek-v4/.test(bare)) return 1_000_000;
    if (bare.includes('v3') || bare.includes('r1')) return 128_000;
    return 64_000;
  }

  if (provider.includes('mistral') || bare.includes('mistral') || bare.includes('magistral')) {
    if (bare.includes('large') || bare.includes('medium-3') || bare.includes('medium_3')) return 128_000;
    if (bare.includes('nemo') || bare.includes('codestral')) return 256_000;
    if (bare.includes('small') || bare.includes('medium')) return 32_768;
    return 32_768;
  }

  // Groq-hosted families
  if (provider.includes('groq') || bare.includes('gpt-oss') || bare.includes('llama') || bare.includes('mixtral')) {
    if (bare.includes('gpt-oss')) return 131_072;
    if (bare.includes('llama-3.1') || bare.includes('llama3.1') || bare.includes('llama-3.3')) return 131_072;
    if (bare.includes('llama-3') || bare.includes('llama3')) return 8_192;
    if (bare.includes('mixtral')) return 32_768;
  }

  if (bare.includes('qwen')) {
    // Qwen3 / Qwen2.5 long context
    if (/qwen3|qwen-3|qwen2\.5|qwen2-5/.test(bare)) return 131_072;
    if (bare.includes('qwen2')) return 32_768;
    return 32_768;
  }

  if (provider.includes('groq')) return 8_192;

  return null;
}

export function buildFallbackContextBudget(params: {
  messages: RequestMessage[];
  contextWindow?: number;
  maxTokens?: number;
}): ContextBudgetValue {
  const contextWindow = Math.max(1, Number(params.contextWindow) || 4096);
  const maxTokensSetting = Number(params.maxTokens) || Math.floor(contextWindow * 0.1);
  const reserved = Math.min(maxTokensSetting, Math.floor(contextWindow * 0.2));
  const effectiveMax = Math.max(1, contextWindow - reserved);
  const usedTokens = estimateTokensFromMessages(params.messages);

  return {
    maxContext: contextWindow,
    usedTokens,
    remaining: Math.max(0, effectiveMax - usedTokens),
    usagePercent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
    isOverflow: usedTokens > effectiveMax,
    reservedForCompletion: reserved
  };
}

export async function buildLocalContextBudget(params: {
  invoke: InvokeFn;
  contextLength?: number;
  maxTokens?: number;
  messages: RequestMessage[];
}): Promise<ContextBudgetValue | null> {
  const budget = await params.invoke<unknown>('build_context_budget', {
    config: {
      context_length: params.contextLength || 4096,
      max_tokens: params.maxTokens
    },
    messages: params.messages
  });
  return normalizeLocalContextBudget(budget);
}

export async function buildApiContextBudgetFromMessages(params: {
  invoke: InvokeFn;
  messages: RequestMessage[];
  contextWindow: number;
  providerMaxTokens?: number;
  modelMetadata: ApiModelMetadataValue;
}): Promise<ContextBudgetValue> {
  const totalTokens = await countMessageTokens(params.messages, params.invoke);
  return buildApiContextBudget({
    totalTokens,
    contextWindow: params.contextWindow,
    providerMaxTokens: params.providerMaxTokens,
    modelMetadata: params.modelMetadata
  });
}

export function normalizeApiModelMetadata(input: unknown): ApiModelMetadataValue | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<ApiModelMetadataValue>;
  const price = (amount: unknown): number | undefined => {
    if (amount == null || amount === '') return undefined;
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const metadata: ApiModelMetadataValue = {
    context_window: Number(value.context_window) || 0,
    max_completion_tokens: Number(value.max_completion_tokens) || undefined,
    prompt_cost_per_million: price(value.prompt_cost_per_million),
    completion_cost_per_million: price(value.completion_cost_per_million)
  };
  return metadata.context_window > 0 ? metadata : null;
}

/** Reported runtime usage remains authoritative after compaction. Drafts are estimates. */
export function homeRuntimeBudget(meta: { contextWindow: number; contextTokens?: number; estimated?: boolean; contextBreakdown?: ContextBreakdown }, draft = ''): ContextBudgetValue | null {
  if (!Number.isFinite(meta.contextWindow) || meta.contextWindow <= 0 || !Number.isFinite(meta.contextTokens)) return null;
  const maxContext = meta.contextWindow;
  const usedTokens = Math.max(0, meta.contextTokens || 0) + (draft ? Math.ceil(draft.length / 4) + 4 : 0);
  const breakdown = meta.contextBreakdown && { ...meta.contextBreakdown, messages: meta.contextBreakdown.messages + (draft ? Math.ceil(draft.length / 4) + 4 : 0) };
  return { maxContext, usedTokens, remaining: Math.max(0, maxContext - usedTokens), usagePercent: Math.min(100, usedTokens / maxContext * 100), isOverflow: usedTokens > maxContext, reservedForCompletion: breakdown?.reserve ?? 0, estimated: !!draft || !!meta.estimated, breakdown };
}
