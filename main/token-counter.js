import { getLlamaStatus } from './llm-runner.js';

export async function countTokens(text, baseUrl) {
  const url = baseUrl || `http://127.0.0.1:${getLlamaStatus().port || 11435}`;
  try {
    const resp = await fetch(`${url}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return estimateTokensFromText(text);
    const data = await resp.json();
    return Array.isArray(data.tokens) ? data.tokens.length : estimateTokensFromText(text);
  } catch {
    return estimateTokensFromText(text);
  }
}

export function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateTokensFromMessages(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 4;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    total += estimateTokensFromText(content);
    if (msg.reasoning) total += estimateTokensFromText(msg.reasoning);
  }
  return total;
}

export function buildContextBudget(config, messages) {
  const maxContext = Number(config.context_length) || 4096;
  const maxTokens = Number(config.max_tokens) || Math.floor(maxContext * 0.3);
  const usedTokens = estimateTokensFromMessages(messages);
  const reservedForCompletion = maxTokens;
  const remaining = maxContext - usedTokens - reservedForCompletion;
  const usagePercent = Math.round((usedTokens / maxContext) * 100);
  const isOverflow = remaining < 0;

  return {
    maxContext,
    usedTokens,
    remaining: Math.max(0, remaining),
    usagePercent: Math.min(100, usagePercent),
    isOverflow,
    reservedForCompletion
  };
}

export function truncateMessages(messages, budget) {
  if (!budget.isOverflow) return messages;

  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  const maxTokens = budget.maxContext - budget.reservedForCompletion;

  let tokenCount = estimateTokensFromMessages(systemMessages);
  const kept = [];

  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const msg = nonSystemMessages[i];
    const msgTokens = estimateTokensFromMessages([msg]);
    if (tokenCount + msgTokens > maxTokens) break;
    tokenCount += msgTokens;
    kept.unshift(msg);
  }

  return [...systemMessages, ...kept];
}

