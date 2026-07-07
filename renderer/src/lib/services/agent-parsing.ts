type ToolCallShape = { name: string; arguments: Record<string, unknown> };

export function parseXmlToolCall(content: string): { toolCall: ToolCallShape | null; cleanContent: string } {
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

function extractBalancedJson(str: string): string | null {
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{' || str[i] === '[') { start = i; break; }
  }
  if (start === -1) return null;
  const opener = str[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

export function parseToolCallCodeblocks(content: string): { toolCalls: ToolCallShape[]; cleanContent: string } {
  const fenceRegex = /```tool_call\s*\n([\s\S]*?)\n```/gi;
  let match: RegExpExecArray | null;
  let clean = content;
  const allCalls: ToolCallShape[] = [];
  while ((match = fenceRegex.exec(content)) !== null) {
    const inner = match[1].trim();
    const json = extractBalancedJson(inner);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const entry = item as { name?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
          if (typeof entry.name === 'string') {
            allCalls.push({ name: entry.name, arguments: entry.arguments || entry.args || {} });
          }
        }
      } else {
        const entry = parsed as { name?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
        if (typeof entry.name === 'string') {
          allCalls.push({ name: entry.name, arguments: entry.arguments || entry.args || {} });
        }
      }
    } catch {
      // ignore
    }
  }
  if (allCalls.length) {
    clean = content.replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '').trim();
  }
  return { toolCalls: allCalls, cleanContent: clean };
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
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripToolPayloads(content: string): string {
  return content
    .replace(/Tool call for\s+[a-z_]+:\s*\{[\s\S]*?\}\s*(?=\n[A-Z]|\n[a-zA-Z][^\n]*:|$)/gi, '')
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeAgentVisibleText(content: string): string {
  return stripToolPayloads(stripInternalAgentChatter(stripAgentDebugLines(content)));
}

export function isPublicFallbackContent(content: string): boolean {
  return /^(Agent stopped because\b|#{0,6}\s*Gathered Evidence\b|No reliable gathered evidence was available\.)/i.test((content || '').trim());
}

export function stripToolCallArtifacts(content: string): string {
  return content
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .trim();
}

const CODEBLOCK_EXT_MAP: Record<string, string> = {
  html: 'index.html', css: 'style.css', js: 'script.js', ts: 'script.ts',
  svg: 'icon.svg', json: 'data.json', xml: 'config.xml',
  py: 'script.py', bash: 'run.sh', sh: 'run.sh',
  yaml: 'config.yaml', yml: 'config.yml', toml: 'config.toml',
  txt: 'readme.txt', md: 'readme.md'
};

export function parseCodeblockWrites(content: string): Array<{ path: string; code: string }> {
  const matches = content.matchAll(/```(\w+)\s*\n([\s\S]*?)```/g);
  const files: Array<{ path: string; code: string }> = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const lang = m[1].toLowerCase();
    const code = m[2].trim();
    if (!code) continue;
    const ext = CODEBLOCK_EXT_MAP[lang];
    if (ext && !seen.has(ext)) {
      seen.add(ext);
      files.push({ path: ext, code });
    }
  }
  return files;
}
