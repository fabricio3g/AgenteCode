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
  const usagePercent = Math.min(100, Math.round((params.totalTokens / effectiveMax) * 100));
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
