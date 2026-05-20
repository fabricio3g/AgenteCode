import type { AgentArtifact, AgentStep } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';
import type { ToolCall, ToolResult } from '$lib/services/agent-types';

export function createRunningToolStep(
  toolCall: ToolCall,
  stepTypeMap: Record<string, AgentStep['type']>,
  uid: (prefix: string) => string
): AgentStep {
  return {
    id: uid('step'),
    type: stepTypeMap[toolCall.name] || 'tool',
    label: toolCall.name.replace(/_/g, ' '),
    status: 'running',
    detail: toolCall.name === 'write_file'
      ? `path: ${String(toolCall.arguments.path || '').slice(0, 120)}`
      : Object.keys(toolCall.arguments).length
        ? Object.entries(toolCall.arguments).slice(0, 3).map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`).join(', ')
        : undefined
  };
}

export function applyNextTurnMods(messages: RequestMessage[], result: ToolResult): boolean {
  let disableNativeTools = false;
  if (result.nextTurnMods?.disableNativeTools) {
    disableNativeTools = true;
  }
  if (result.nextTurnMods?.instructions) {
    messages[0] = { role: 'system', content: result.nextTurnMods.instructions };
  }
  if (result.nextTurnMods?.injectMessages) {
    messages.push(...result.nextTurnMods.injectMessages);
  }
  return disableNativeTools;
}

export function mergeWebSearchSources(params: {
  toolCall: ToolCall;
  result: ToolResult;
  sources: SearchResult[];
  seenUrls: Set<string>;
  onSources?: (sources: SearchResult[]) => void;
}): void {
  if (params.toolCall.name !== 'web_search' || !params.result.success) return;

  const output = params.result.output as { results?: Array<{ title: string; url: string; snippet?: string }> } | undefined;
  let added = false;
  for (const entry of output?.results ?? []) {
    if (entry.url && !params.seenUrls.has(entry.url)) {
      params.seenUrls.add(entry.url);
      params.sources.push({ title: entry.title || entry.url, url: entry.url, snippet: entry.snippet || '' });
      added = true;
    }
  }
  if (added) params.onSources?.([...params.sources]);
}

export function finalizeToolStep(step: AgentStep, result: ToolResult): void {
  step.status = result.success ? 'done' : 'error';
  if (!result.success && result.note) {
    step.detail = `${result.error} — ${result.note.slice(0, 120)}`;
    step.output = result.error;
    return;
  }
  if (!result.success) {
    step.detail = result.error?.slice(0, 200);
    step.output = result.error || '';
    return;
  }

  step.detail = undefined;
  const output = result.output as Record<string, unknown> | undefined;
  if (output && typeof output === 'object') {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(output)) {
      if (typeof value === 'string') lines.push(`${key}: ${value.slice(0, 200)}`);
    }
    step.output = lines.join('\n') || JSON.stringify(output, null, 2);
  }
}

export function appendToolResultMessage(params: {
  toolCall: ToolCall;
  result: ToolResult;
  messages: RequestMessage[];
  nativeActive: boolean;
  nativeFailed: boolean;
  maxToolResultChars: number;
}): void {
  let resultPayload = params.result.success
    ? (params.result.note ? { ...(params.result.output as object), _note: params.result.note } : params.result.output)
    : { error: params.result.error, ...(params.result.note ? { note: params.result.note } : {}) };
  const rawResultJson = JSON.stringify(resultPayload);
  if (rawResultJson.length > params.maxToolResultChars) {
    resultPayload = {
      _truncated: true,
      _summary: rawResultJson.slice(0, params.maxToolResultChars) + '…(truncated)',
      _result: 'ok'
    };
  }

  if (params.nativeActive && !params.nativeFailed && params.toolCall.id) {
    params.messages.push({
      role: 'tool',
      content: JSON.stringify(resultPayload),
      tool_call_id: params.toolCall.id,
      name: params.toolCall.name
    });
    return;
  }

  params.messages.push({
    role: 'user',
    content: `Tool result for ${params.toolCall.name}:\n${JSON.stringify(resultPayload, null, 2)}`
  });
}

export function publishArtifact(onArtifact: (artifact: AgentArtifact | null) => void, buildArtifact: () => AgentArtifact | null): void {
  onArtifact(buildArtifact());
}
