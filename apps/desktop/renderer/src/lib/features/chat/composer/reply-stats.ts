// The last reply's output, for the composer's status line: "222 tok · 45
// tok/s". Only numbers the provider or runtime reported, never estimates.

import type { ChatMessage } from '$lib/types/chat';
import { formatCount } from '$lib/utils/format';

export function lastReplyStats(messages: ChatMessage[] | undefined, tokensLabel: string): string | undefined {
  const last = [...(messages ?? [])].reverse().find((message) => message.role === 'assistant');
  const meta = last?.metadata;
  if (!meta || (meta.usageSource !== 'provider' && meta.usageSource !== 'runtime')) return undefined;
  const tokens = meta.outputTokens ?? meta.tokens ?? 0;
  const parts = [
    tokens ? `${formatCount(tokens)} ${tokensLabel}` : '',
    meta.tokensPerSecond ? `${meta.tokensPerSecond.toFixed(0)} tok/s` : ''
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}
