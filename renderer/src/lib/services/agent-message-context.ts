import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';
import type { ToolObservation } from '$lib/services/agent-types';

export function injectEvidenceSummary(
  messages: RequestMessage[],
  observations: ToolObservation[],
  liveSources: SearchResult[],
  compactText: (value: unknown, max?: number) => string,
  options: {
    observationLimit?: number;
    observationChars?: number;
    sourceLimit?: number;
    sourceChars?: number;
    instruction?: string;
  } = {}
): void {
  const evidenceIdx = messages.findIndex(
    (message) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('=== EVIDENCE SUMMARY ===')
  );
  if (evidenceIdx >= 0) {
    messages.splice(evidenceIdx, 1);
  }

  const successful = observations.filter((observation) => observation.success && observation.summary);
  if (!successful.length && !liveSources.length) return;

  const observationLimit = Math.max(1, options.observationLimit ?? 15);
  const observationChars = Math.max(120, options.observationChars ?? 400);
  const sourceLimit = Math.max(1, options.sourceLimit ?? 10);
  const sourceChars = Math.max(120, options.sourceChars ?? 250);
  const lines: string[] = ['=== EVIDENCE SUMMARY ==='];
  lines.push(options.instruction || 'The following facts have been gathered from tool results. Use ONLY this data when creating artifacts or answering:');

  for (const observation of successful.slice(0, observationLimit)) {
    lines.push(`- [${observation.name}] ${compactText(observation.summary, observationChars)}`);
  }

  for (const source of liveSources.slice(0, sourceLimit)) {
    const title = source.title || source.url;
    const url = source.url && source.title ? ` (${source.url})` : '';
    const excerpt = source.full_content || source.snippet || '';
    lines.push(`- [source] ${title}${url}: ${compactText(excerpt, sourceChars)}`);
  }

  lines.push('=== END EVIDENCE ===');
  messages.push({ role: 'system', content: lines.join('\n') });
}

export function trimContext(messages: RequestMessage[], keepCount: number): void {
  const sys = messages.filter((message) => message.role === 'system');
  const nonSys = messages.filter((message) => message.role !== 'system');

  if (nonSys.length <= keepCount) return;

  const firstUserIndex = nonSys.findIndex((message) => message.role === 'user');
  const firstUser = firstUserIndex >= 0 ? nonSys[firstUserIndex] : null;
  const lastUserIndex = (() => {
    for (let i = nonSys.length - 1; i >= 0; i--) {
      if (nonSys[i].role === 'user') return i;
    }
    return -1;
  })();
  const lastUser = lastUserIndex >= 0 ? nonSys[lastUserIndex] : null;

  const tail = nonSys.slice(-keepCount);

  const result = [...sys];
  if (firstUser && !tail.includes(firstUser)) {
    result.push(firstUser);
  }
  if (lastUser && lastUser !== firstUser && !tail.includes(lastUser)) {
    result.push(lastUser);
  }
  result.push(...tail);

  messages.splice(0, messages.length, ...result);
}
