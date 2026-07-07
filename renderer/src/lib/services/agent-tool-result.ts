import type { AgentArtifact, AgentStep, CodeAgentFileChange, CodeAgentFileChangeKind } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';
import type { ToolCall, ToolResult } from '$lib/services/agent-types';

export function createRunningToolStep(
  toolCall: ToolCall,
  stepTypeMap: Record<string, AgentStep['type']>,
  uid: (prefix: string) => string
): AgentStep {
  const label = displayToolLabel(toolCall.name);
  const detail = displayToolDetail(toolCall.name, toolCall.arguments);
  return {
    id: uid('step'),
    type: stepTypeMap[toolCall.name] || 'tool',
    label,
    status: 'running',
    detail
  };
}

export function displayToolLabel(name: string): string {
  switch (name) {
    case 'web_search': return 'Search';
    case 'fetch_url': return 'Read';
    case 'query_knowledge': return 'Read knowledge';
    case 'read_file': return 'Read file';
    case 'list_files': return 'List files';
    case 'search_files': return 'Search files';
    case 'write_file': return 'Write file';
    case 'create_report': return 'Create report';
    case 'create_work_product': return 'Create report';
    case 'create_document': return 'Create document';
    case 'create_spreadsheet': return 'Create spreadsheet';
    case 'create_presentation': return 'Create presentation';
    case 'create_pdf': return 'Create PDF';
    case 'preview_project': return 'Preview';
    case 'calculator': return 'Calculate';
    default: return name.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function displayToolDetail(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'web_search') {
    const query = String(args.query || '').trim();
    return query ? query.slice(0, 180) : undefined;
  }
  if (name === 'fetch_url') {
    const title = String(args.title || args.name || '').trim();
    const url = String(args.url || '').trim();
    if (title && url) return `${title} · ${url}`.slice(0, 220);
    return (title || url || undefined)?.slice(0, 220);
  }
  if (name === 'write_file' || name === 'read_file') {
    const path = String(args.path || '').trim();
    return path ? path.slice(0, 160) : undefined;
  }
  if (name.startsWith('create_')) {
    const title = String(args.title || '').trim();
    const path = String(args.path || '').trim();
    return (title || path || undefined)?.slice(0, 180);
  }
  return Object.keys(args).length
    ? Object.entries(args).slice(0, 3).map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`).join(', ')
    : undefined;
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

  const output = params.result.output as { results?: SearchResult[] } | undefined;
  let added = false;
  for (const entry of output?.results ?? []) {
    if (!entry.url) continue;
    if (params.seenUrls.has(entry.url)) {
      const existing = params.sources.find((source) => source.url === entry.url);
      if (existing && ((entry.full_content || '').length > (existing.full_content || '').length || (entry.snippet || '').length > (existing.snippet || '').length)) {
        Object.assign(existing, { ...entry, title: entry.title || existing.title || entry.url, url: entry.url });
        added = true;
      }
      continue;
    }
    params.seenUrls.add(entry.url);
    params.sources.push({ ...entry, title: entry.title || entry.url, url: entry.url, snippet: entry.snippet || '' });
    added = true;
  }
  if (added) params.onSources?.([...params.sources]);
}

export function finalizeToolStep(step: AgentStep, result: ToolResult): void {
  step.status = result.success ? 'done' : 'error';
  const fileChanges = fileChangesFromResult(result);
  if (fileChanges.length) step.fileChanges = fileChanges;
  else delete step.fileChanges;
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

function fileChangesFromResult(result: ToolResult): CodeAgentFileChange[] {
  const changes: CodeAgentFileChange[] = [];
  const add = (paths: string[] | undefined, kind: CodeAgentFileChangeKind) => {
    for (const path of paths || []) {
      const normalized = String(path || '').trim();
      if (normalized) changes.push({ path: normalized, kind });
    }
  };
  add(result.createdFiles, 'created');
  add(result.modifiedFiles, 'modified');
  add(result.deletedFiles, 'deleted');
  return changes;
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
