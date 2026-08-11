import type { AgentArtifact, AgentStep, CodeAgentFileChange, CodeAgentFileChangeKind } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import { say } from '$lib/copy';
import type { SearchResult } from '$lib/types/tauri';
import type { ToolCall, ToolResult } from '$lib/services/agent-types';

const OPTIONAL_PRESENTATION_TOOLS = new Set([
  'create_info_card',
  'create_html_card',
  'create_chart',
  'create_dashboard',
  'create_diagram',
  'create_map'
]);

const PRESENTATION_VALIDATION_ERROR =
  /\b(?:requires?|must (?:include|contain|provide|have|be)|at least one|missing|empty|invalid (?:row|data|content|metric|series|node|location|html))\b/i;

export function recoverOptionalPresentationFailure(toolCall: ToolCall, result: ToolResult): ToolResult {
  if (result.success || !OPTIONAL_PRESENTATION_TOOLS.has(toolCall.name)) return result;
  const reason = String(result.error || '').trim();
  if (!PRESENTATION_VALIDATION_ERROR.test(reason)) return result;

  return {
    success: true,
    output: {
      created: false,
      skipped: true,
      reason: reason || 'The optional visual did not contain enough valid data.'
    },
    note: 'The optional visual was skipped. Continue with the requested answer or report using the evidence already gathered.'
  };
}

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
    case 'export_research_package': return 'Export research';
    case 'create_info_card': return 'Info card';
    case 'create_html_card': return 'HTML card';
    case 'create_chart': return 'Chart';
    case 'create_dashboard': return 'Dashboard';
    case 'get_weather': return 'Weather';
    case 'convert_currency': return 'Currency';
    case 'get_quote': return 'Quote';
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

function upsertSource(
  sources: SearchResult[],
  seenUrls: Set<string>,
  entry: SearchResult
): boolean {
  if (!entry.url) return false;
  if (seenUrls.has(entry.url)) {
    const existing = sources.find((source) => source.url === entry.url);
    if (!existing) return false;
    const richerContent =
      (entry.full_content || '').length > (existing.full_content || '').length
      || (entry.snippet || '').length > (existing.snippet || '').length
      || (!!entry.title && entry.title !== existing.title && entry.title !== entry.url);
    if (!richerContent) return false;
    Object.assign(existing, {
      ...entry,
      title: entry.title || existing.title || entry.url,
      url: entry.url,
      snippet: (entry.snippet || '').length > (existing.snippet || '').length ? entry.snippet : existing.snippet,
      full_content: (entry.full_content || '').length > (existing.full_content || '').length
        ? entry.full_content
        : existing.full_content,
      metadata: { ...(existing.metadata || {}), ...(entry.metadata || {}) }
    });
    return true;
  }
  seenUrls.add(entry.url);
  sources.push({
    ...entry,
    title: entry.title || entry.url,
    url: entry.url,
    snippet: entry.snippet || ''
  });
  return true;
}

/** Merge sources from web_search / fetch_url tool results into the live list. */
export function mergeWebSearchSources(params: {
  toolCall: ToolCall;
  result: ToolResult;
  sources: SearchResult[];
  seenUrls: Set<string>;
  onSources?: (sources: SearchResult[]) => void;
}): void {
  if (!params.result.success) return;
  const name = params.toolCall.name;
  if (name !== 'web_search' && name !== 'fetch_url') return;

  let added = false;
  const output = params.result.output as Record<string, unknown> | undefined;

  if (name === 'web_search') {
    const results = (output as { results?: SearchResult[] } | undefined)?.results ?? [];
    for (const entry of results) {
      if (upsertSource(params.sources, params.seenUrls, {
        ...entry,
        title: entry.title || entry.url,
        url: entry.url || '',
        snippet: entry.snippet || '',
        full_content: entry.full_content || ''
      })) {
        added = true;
      }
    }
  } else if (name === 'fetch_url' && output?.url) {
    const url = String(output.url || '');
    const content = String(output.content || '');
    const excerpt = String(output.excerpt || '');
    if (upsertSource(params.sources, params.seenUrls, {
      title: String(output.title || url || 'Fetched source'),
      url,
      snippet: excerpt || content.slice(0, 420),
      full_content: content,
      provider: 'fetch_url',
      metadata: {
        quality: output.quality,
        warning: output.warning,
        site_name: output.site_name,
        file_type: output.file_type
      }
    })) {
      added = true;
    }
  }

  if (added) params.onSources?.([...params.sources]);
}

function shortToolStepSummary(toolName: string | undefined, output: Record<string, unknown>): { detail?: string; output: string } {
  if (output.skipped === true) {
    const reason = String(output.reason || 'optional output was not needed').slice(0, 180);
    return { detail: `Skipped — ${reason}`, output: reason };
  }

  if (toolName === 'web_search' || (!toolName && Array.isArray(output.results))) {
    const results = Array.isArray(output.results) ? output.results : [];
    const count = results.length;
    const query = String(output.query || '').trim();
    const first = results[0] as { title?: string } | undefined;
    const firstTitle = first?.title ? String(first.title).slice(0, 80) : '';
    const detail = query
      ? (count ? say.results(count) : 'No results')
      : undefined;
    const line = count
      ? `${say.results(count)}${firstTitle ? ` · ${firstTitle}` : ''}`
      : 'No results';
    return { detail, output: line };
  }

  if (toolName === 'fetch_url' || (output.url && (output.content != null || output.excerpt != null || output.title != null))) {
    const title = String(output.title || '').trim();
    const url = String(output.url || '').trim();
    let host = '';
    try {
      host = url ? new URL(url).hostname.replace(/^www\./, '') : '';
    } catch {
      host = '';
    }
    const quality = output.quality ? String(output.quality) : '';
    const label = title || host || url || 'Page';
    const parts = [label];
    if (host && title && !title.includes(host)) parts.push(host);
    if (quality) parts.push(quality);
    return { output: parts.join(' · ').slice(0, 220) };
  }

  // Generic: pick a few short human fields; never dump huge blobs.
  const preferred = ['title', 'result', 'path', 'name', 'expression', 'summary', 'message'];
  const lines: string[] = [];
  for (const key of preferred) {
    const value = output[key];
    if (typeof value === 'string' && value.trim()) {
      lines.push(`${key}: ${value.slice(0, 160)}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    }
    if (lines.length >= 3) break;
  }
  if (!lines.length) {
    for (const [key, value] of Object.entries(output)) {
      if (key === 'context' || key === 'content' || key === 'next_step' || key === 'results') continue;
      if (typeof value === 'string' && value.trim()) {
        lines.push(`${key}: ${value.slice(0, 120)}`);
      }
      if (lines.length >= 2) break;
    }
  }
  return { output: lines.join('\n') || 'Done' };
}

export function finalizeToolStep(step: AgentStep, result: ToolResult, toolName?: string): void {
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

  const output = result.output as Record<string, unknown> | undefined;
  if (output && typeof output === 'object') {
    const summary = shortToolStepSummary(toolName || undefined, output);
    // Keep running detail (e.g. search query) when summary has no better detail.
    if (summary.detail !== undefined) step.detail = summary.detail;
    else if (toolName === 'web_search' || toolName === 'fetch_url') {
      // Prefer short result summary over long query/url once done.
      step.detail = summary.output;
    }
    step.output = summary.output;
    return;
  }
  step.detail = undefined;
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

  // Always prefer proper tool role when we have an id — required after assistant tool_calls.
  // Generate id if missing so we never leave unpaired native tool_calls.
  const toolCallId = params.toolCall.id || `call_${Math.random().toString(36).slice(2, 10)}`;
  if (!params.toolCall.id) params.toolCall.id = toolCallId;

  const lastAssistant = [...params.messages].reverse().find((m) => m.role === 'assistant');
  const expectsToolRole =
    (params.nativeActive && !params.nativeFailed)
    || !!(lastAssistant?.tool_calls?.some((tc) => tc.id === toolCallId));

  /*
   * The condition is `expectsToolRole` alone. It used to be
   * `expectsToolRole || params.toolCall.id`, and since the line above *always*
   * assigns an id, that was unconditionally true and the `role: 'user'` branch below
   * was unreachable.
   *
   * That mattered because XML and code-fence tool parses produce calls with no id and
   * push assistant messages with no `tool_calls`. Their results were emitted as
   * `role: 'tool'` with no parent block, and `ensureToolCallPairs` then deleted them
   * as orphans on the next iteration. Every local model runs XML mode, so local
   * models never saw the results of their own tool calls — they just re-called the
   * same tool. The plain-text form below survives that pass.
   */
  if (expectsToolRole) {
    params.messages.push({
      role: 'tool',
      content: JSON.stringify(resultPayload),
      tool_call_id: toolCallId,
      name: params.toolCall.name
    });
    return;
  }

  params.messages.push({
    role: 'user',
    content: `Tool result for ${params.toolCall.name}:\n${JSON.stringify(resultPayload, null, 2)}`
  });
}

/**
 * Publish the artifacts accumulated so far for a turn.
 *
 * This takes the whole list rather than a single artifact because a turn can create
 * several — a chart *and* a diagram, or a report *and* a spreadsheet. It used to
 * take one, which combined with a single shared storage slot meant only the last
 * one in a turn ever reached the screen.
 */
export function publishArtifacts(
  onArtifact: (artifacts: AgentArtifact[]) => void,
  artifacts: AgentArtifact[]
): void {
  onArtifact([...artifacts]);
}
