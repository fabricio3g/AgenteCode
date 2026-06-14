import type { RequestMessage } from '$lib/services/chat-api';

export interface ContextBudgetValue {
  maxContext: number;
  usedTokens: number;
  remaining: number;
  usagePercent: number;
  isOverflow: boolean;
  reservedForCompletion: number;
  promptCostPerMillionUsd?: number;
  completionCostPerMillionUsd?: number;
  estimatedInputCostUsd?: number;
}

export interface ApiModelMetadataValue {
  context_window: number;
  max_completion_tokens?: number;
  prompt_cost_per_million?: number;
  completion_cost_per_million?: number;
}

export type InvokeFn = <T = unknown>(channel: string, payload?: unknown) => Promise<T>;

export function normalizeLocalContextBudget(input: unknown): ContextBudgetValue | null {
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

export async function countMessageTokens(messages: RequestMessage[], invoke: InvokeFn): Promise<number> {
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
  const estimatedInputCostUsd = promptCostPerMillionUsd
    ? (params.totalTokens / 1_000_000) * promptCostPerMillionUsd
    : undefined;

  return {
    maxContext: params.contextWindow,
    usedTokens: params.totalTokens,
    remaining,
    usagePercent,
    isOverflow: params.totalTokens > effectiveMax,
    reservedForCompletion: reserved,
    promptCostPerMillionUsd,
    completionCostPerMillionUsd,
    estimatedInputCostUsd
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

export function inferContextWindowFromModel(providerName?: string, modelId?: string): number | null {
  const provider = String(providerName || '').toLowerCase();
  const model = String(modelId || '').toLowerCase();
  if (!model) return null;

  if (provider.includes('anthropic') || model.includes('claude')) {
    if (model.includes('instant')) return 100_000;
    return 200_000;
  }

  if (provider.includes('gemini') || model.includes('gemini')) {
    if (/gemini-(?:1\.5|2\.|2-|flash|pro)/.test(model)) return 1_000_000;
    return 32_768;
  }

  if (model.includes('gpt-4.1') || model.includes('gpt-4o') || model.includes('gpt-4-turbo') || /o[134]\b/.test(model)) return 128_000;
  if (model.includes('gpt-4-32k')) return 32_768;
  if (model.includes('gpt-4')) return 8_192;
  if (model.includes('gpt-3.5-turbo')) return 16_384;
  if (model.includes('gpt-3.5')) return 4_096;

  if (provider.includes('deepseek') || model.includes('deepseek')) {
    if (model.includes('v3') || model.includes('r1')) return 128_000;
    return 64_000;
  }

  if (provider.includes('mistral') || model.includes('mistral')) {
    if (model.includes('large')) return 128_000;
    if (model.includes('small') || model.includes('medium')) return 32_768;
    if (model.includes('nemo') || model.includes('codestral')) return 256_000;
    return 32_768;
  }

  if (provider.includes('groq') || model.includes('groq') || model.includes('llama') || model.includes('mixtral')) {
    if (model.includes('llama-3.1') || model.includes('llama3.1')) return 131_072;
    if (model.includes('llama-3') || model.includes('llama3')) return 8_192;
    if (model.includes('mixtral')) return 32_768;
    return 8_192;
  }

  if (model.includes('qwen')) {
    if (model.includes('qwen2.5') || model.includes('qwen2-5')) return 131_072;
    if (model.includes('qwen2')) return 32_768;
    return 32_768;
  }

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
  const metadata: ApiModelMetadataValue = {
    context_window: Number(value.context_window) || 0,
    max_completion_tokens: Number(value.max_completion_tokens) || undefined,
    prompt_cost_per_million: Number(value.prompt_cost_per_million) || undefined,
    completion_cost_per_million: Number(value.completion_cost_per_million) || undefined
  };
  return metadata.context_window > 0 ? metadata : null;
}
