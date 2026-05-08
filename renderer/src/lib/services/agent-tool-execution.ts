import type { AgentArtifact, AgentStep } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';

type ToolCallLike = { id?: string; name: string; arguments: Record<string, unknown> };

type ToolResultLike = {
  success: boolean;
  output?: unknown;
  error?: string;
  note?: string;
  nextTurnMods?: {
    instructions?: string;
    injectMessages?: RequestMessage[];
    disableNativeTools?: boolean;
  };
};

type ToolObservationLike = {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  summary: string;
};

export async function executeSingleTool(params: {
  tc: ToolCallLike;
  steps: AgentStep[];
  args: {
    onProgress?: (text: string) => void;
    onStep: (steps: AgentStep[]) => void;
    onArtifact: (artifact: AgentArtifact | null) => void;
    onSources?: (sources: SearchResult[]) => void;
  };
  ctx: { signal?: AbortSignal };
  messages: RequestMessage[];
  sources: SearchResult[];
  seenUrls: Set<string>;
  observations: ToolObservationLike[];
  nativeActive: boolean;
  nativeFailed: boolean;
  stepTypeMap: Record<string, AgentStep['type']>;
  uid: (prefix: string) => string;
  executeToolWithTimeout: (name: string, args: Record<string, unknown>) => Promise<ToolResultLike>;
  summarizeToolObservation: (name: string, args: Record<string, unknown>, result: ToolResultLike) => ToolObservationLike;
  buildArtifact: () => AgentArtifact | null;
  maxToolResultChars: number;
}): Promise<boolean> {
  const {
    tc, steps, args, ctx, messages, sources, seenUrls, observations,
    nativeActive, stepTypeMap, uid, executeToolWithTimeout,
    summarizeToolObservation, buildArtifact, maxToolResultChars
  } = params;
  let nativeFailed = params.nativeFailed;

  args.onProgress?.(`Running ${tc.name.replace(/_/g, ' ')}…`);

  const toolStep: AgentStep = {
    id: uid('step'),
    type: stepTypeMap[tc.name] || 'tool',
    label: tc.name.replace(/_/g, ' '),
    status: 'running',
    detail: tc.name === 'write_file'
      ? `path: ${String(tc.arguments.path || '').slice(0, 120)}`
      : Object.keys(tc.arguments).length
        ? Object.entries(tc.arguments).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(', ')
        : undefined
  };
  steps.push(toolStep);
  args.onStep([...steps]);

  const result = await executeToolWithTimeout(tc.name, tc.arguments);
  ctx.signal?.throwIfAborted?.();
  observations.push(summarizeToolObservation(tc.name, tc.arguments, result));

  if (result.nextTurnMods?.disableNativeTools) {
    nativeFailed = true;
  }
  if (result.nextTurnMods?.instructions) {
    messages[0] = { role: 'system', content: result.nextTurnMods.instructions };
  }
  if (result.nextTurnMods?.injectMessages) {
    messages.push(...result.nextTurnMods.injectMessages);
  }

  if (tc.name === 'web_search' && result.success) {
    const output = result.output as { results?: Array<{ title: string; url: string; snippet?: string }> } | undefined;
    let added = false;
    for (const entry of output?.results ?? []) {
      if (entry.url && !seenUrls.has(entry.url)) {
        seenUrls.add(entry.url);
        sources.push({ title: entry.title || entry.url, url: entry.url, snippet: entry.snippet || '' });
        added = true;
      }
    }
    if (added) args.onSources?.([...sources]);
  }

  toolStep.status = result.success ? 'done' : 'error';
  if (!result.success && result.note) {
    toolStep.detail = `${result.error} — ${result.note.slice(0, 120)}`;
    toolStep.output = result.error;
  } else if (!result.success) {
    toolStep.detail = result.error?.slice(0, 200);
    toolStep.output = result.error || '';
  } else {
    toolStep.detail = undefined;
    const output = result.output as Record<string, unknown> | undefined;
    if (output && typeof output === 'object') {
      const lines: string[] = [];
      for (const [key, value] of Object.entries(output)) {
        if (typeof value === 'string') lines.push(`${key}: ${value.slice(0, 200)}`);
      }
      toolStep.output = lines.join('\n') || JSON.stringify(output, null, 2);
    }
  }

  args.onArtifact(buildArtifact());
  args.onStep([...steps]);

  let resultPayload = result.success
    ? (result.note ? { ...(result.output as object), _note: result.note } : result.output)
    : { error: result.error, ...(result.note ? { note: result.note } : {}) };
  const rawResultJson = JSON.stringify(resultPayload);
  if (rawResultJson.length > maxToolResultChars) {
    resultPayload = { _truncated: true, _summary: rawResultJson.slice(0, maxToolResultChars) + '…(truncated)', _result: 'ok' };
  }

  if (nativeActive && !nativeFailed && tc.id) {
    messages.push({ role: 'tool', content: JSON.stringify(resultPayload), tool_call_id: tc.id, name: tc.name });
  } else {
    messages.push({ role: 'user', content: `Tool result for ${tc.name}:\n${JSON.stringify(resultPayload, null, 2)}` });
  }

  return nativeFailed;
}
