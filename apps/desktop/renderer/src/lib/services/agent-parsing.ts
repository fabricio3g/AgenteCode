type ToolCallShape = { name: string; arguments: Record<string, unknown> };

/**
 * Tool names the agent loop can execute. Used only to tell a degraded
 * `name="web_search"> …` fragment's tool name apart from its argument names —
 * never to reject a call (unknown names still pass through).
 */
const KNOWN_TOOL_NAMES = new Set([
  'web_search', 'fetch_url', 'query_knowledge', 'calculator',
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_files', 'search_files',
  'create_report', 'create_work_product', 'create_document', 'create_spreadsheet',
  'create_presentation', 'create_pdf', 'create_info_card', 'create_html_card', 'create_widget', 'create_lesson',
  'create_chart', 'create_dashboard', 'create_diagram', 'create_map',
  'get_weather', 'convert_currency', 'get_quote', 'preview_project',
  'get_diagnostics'
]);

/**
 * True when the text reads like a model describing tool use instead of doing
 * it — planning sentences ("I'll use the web_search tool…") or tagless
 * `name="web_search"> name="query">…` fragments. Small models emit both when
 * the XML tool contract does not stick.
 */
export function hasToolIntent(content: string): boolean {
  const text = String(content || '');
  if (!text.trim()) return false;
  if (/name\s*=\s*"[A-Za-z_][\w-]*"\s*>/.test(text)) return true;
  if (/<\/?tool_call/i.test(text)) return true;
  return /\b(i['’]ll|i will|let me|going to)\b[^.\n]{0,80}\b(use|call|invoke|run|query)\b[^.\n]{0,60}\b(tool|web_search|fetch_url|search)\b/i.test(text)
    || /\busing the \w+ tool\b/i.test(text);
}

function cleanDegradedValue(value: string): string {
  return String(value || '')
    .replace(/<\/?[^>]*>/g, '')
    .replace(/^['">\s]+|['"<\s]+$/g, '')
    .trim();
}

/**
 * Parse the tagless shape small models emit when the `<tool_call>` contract
 * does not stick — one call per line:
 *
 *   name="web_search"> name="query">best LLM 2026 investigate
 *
 * The first `name="…"` on the line is the tool; the rest are arguments with
 * values running to the next `name="` or end of line. Lines whose first name
 * is unknown *and* carry no arguments are left alone so prose that happens to
 * mention `name="…"` never becomes a phantom tool call.
 */
export function parseDegradedXmlToolCalls(content: string): { toolCalls: ToolCallShape[]; cleanContent: string } {
  const text = String(content || '');
  const toolCalls: ToolCallShape[] = [];
  let clean = text;
  const pairRe = /name\s*=\s*"([A-Za-z_][\w-]*?)"\s*>/gi;

  for (const line of text.split('\n')) {
    pairRe.lastIndex = 0;
    const pairs: Array<{ name: string; valueStart: number; matchStart: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = pairRe.exec(line)) !== null) {
      pairs.push({ name: match[1], valueStart: match.index + match[0].length, matchStart: match.index });
    }
    if (!pairs.length) continue;
    const toolName = pairs[0].name;
    // Unknown tool names are only trusted with explicit arguments; a bare
    // unknown `name="…">` in prose must never become a phantom tool call.
    if (!KNOWN_TOOL_NAMES.has(toolName)) continue;
    const args: Record<string, unknown> = {};
    for (let i = 1; i < pairs.length; i++) {
      const end = i + 1 < pairs.length ? pairs[i + 1].matchStart : line.length;
      const value = cleanDegradedValue(line.slice(pairs[i].valueStart, end));
      if (value) args[pairs[i].name] = value;
    }
    toolCalls.push({ name: toolName, arguments: args });
    clean = clean.replace(line, '');
  }

  return { toolCalls, cleanContent: clean.replace(/\n{3,}/g, '\n\n').trim() };
}

export function parseXmlToolCall(content: string): { toolCall: ToolCallShape | null; cleanContent: string } {
  // Some local models put the tool and JSON arguments in attributes instead
  // of the body. Respect quoted '>' characters inside JSON strings.
  const attributeTag = content.match(/<tool_call\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>(?:\s*<\/tool_call\s*>)?/i);
  if (attributeTag) {
    const attributes: Record<string, string> = {};
    for (const match of attributeTag[1].matchAll(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attributes[match[1]] = match[3] ?? match[4];
    }
    const name = attributes.name || attributes.label;
    const parameters = attributes.arguments || attributes.parameters;
    if (name && parameters) {
      try {
        const args: unknown = JSON.parse(parameters);
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          return {
            toolCall: { name, arguments: args as Record<string, unknown> },
            cleanContent: content.replace(attributeTag[0], '').trim()
          };
        }
      } catch { /* Leave malformed calls for the format-repair turn. */ }
    }
  }
  const tagMatch = content.match(/<tool_call[\s\S]*?>([\s\S]*?)<\/tool_call>/i);
  if (!tagMatch) return { toolCall: null, cleanContent: content.trim() };
  const inner = tagMatch[1];
  const jsonStart = inner.indexOf('{');
  if (jsonStart === -1) return { toolCall: null, cleanContent: content.trim() };
  let depth = 0;
  let jsonEnd = -1;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < inner.length; i++) {
    const c = inner[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }
  if (jsonEnd === -1) return { toolCall: null, cleanContent: content.trim() };
  const jsonStr = inner.slice(jsonStart, jsonEnd + 1);
  try {
    const parsed = JSON.parse(jsonStr) as { name?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
    if (typeof parsed.name !== 'string') throw new Error('missing name');
    return {
      toolCall: { name: parsed.name, arguments: parsed.arguments || parsed.args || {} },
      cleanContent: content.replace(tagMatch[0], '').trim()
    };
  } catch {
    return { toolCall: null, cleanContent: content.trim() };
  }
}

const DEBUG_LINE_RE = /^\[(?:agent|chat-api|agent-llm|TTS|OcrEngine|onboarding)\][\s\S]*$/gm;

function stripAgentDebugLines(content: string): string {
  return content.replace(DEBUG_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripInternalAgentChatter(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/tool call limit|over the limit|preparing to use tools|i will need to provide the answer|❌|used \d+ tools/i.test(line))
    .filter((line) => !/^\s*\|\s*$/.test(line))
    // Planning-about-tools is draft, not answer: "I'll use the web_search
    // tool to find…", "Let me use the fetch_url tool…".
    .filter((line) => !/^\s*(i['’]ll|i will|let me|i['’]m going to)\b[^.\n]{0,80}\b(use|call|invoke|run|query)\b[^.\n]{0,60}\b(tool|web_search|fetch_url|search)\b/i.test(line))
    .filter((line) => !/^\s*using the \w+ tool\b/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripToolPayloads(content: string): string {
  return stripToolCallArtifacts(content)
    .replace(/Tool call for\s+[a-z_]+:\s*\{[\s\S]*?\}\s*(?=\n[A-Z]|\n[a-zA-Z][^\n]*:|$)/gi, '')
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    // Tagless fragments small models emit (see parseDegradedXmlToolCalls).
    .replace(/name\s*=\s*"[A-Za-z_][\w-]*"\s*>[^<\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeAgentVisibleText(content: string): string {
  return stripToolPayloads(stripInternalAgentChatter(stripAgentDebugLines(content)));
}

export function isPublicFallbackContent(content: string): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  // Legacy evidence-dump fallback
  if (/^(Agent stopped because\b|#{0,6}\s*Gathered Evidence\b|No reliable gathered evidence was available\.)/i.test(text)) {
    return true;
  }
  // Product partial research report (automatic synthesis when model did not finish)
  if (/Partial research report (compiled|from retrieved)/i.test(text)) {
    return true;
  }
  // Human-readable partial answers (post strict-template rewrite)
  if (/Partial answer from sources already retrieved/i.test(text)) {
    return true;
  }
  if (/I could not complete every step, so this is based only on what was already found/i.test(text)) {
    return true;
  }
  if (/I stopped before finishing and did not gather enough information/i.test(text)) {
    return true;
  }
  return false;
}

export function stripToolCallArtifacts(content: string): string {
  return content
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi, '')
    // Hide an unfinished call while streaming, including partial tag names.
    .replace(/<(?:tool_call\b[\s\S]*|t(?:o(?:o(?:l(?:_(?:c(?:a(?:l(?:l)?)?)?)?)?)?)?)?)$/i, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .replace(/```tool_call\b[\s\S]*$/gi, '')
    // Tagless `name="tool"> name="arg">value` fragments (see above).
    .replace(/name\s*=\s*"[A-Za-z_][\w-]*"\s*>[^<\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
