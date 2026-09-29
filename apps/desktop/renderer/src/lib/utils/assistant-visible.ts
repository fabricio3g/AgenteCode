const DEBUG_LINE_RE = /^\[(?:agent|chat-api|agent-llm|TTS|OcrEngine|onboarding)\][\s\S]*$/gm;

const TRANSCRIPT_MARKER_RE =
  /^\s*(?:Thought for \d+(?:\.\d+)?s|Planning|Reasoning|Thinking|Response ready|Web Search|Fetch Url|Fetch URL|Using:\s*.+)\s*$/i;

const META_LINE_RE =
  /^\s*(?:The user (?:wants|asked|asks|is asking|wants to know)|I (?:need|should|can|will|am going|don't need|do not need)|Let me|Now I|I'll|The search results show)\b/i;

function stripToolPayloads(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```tool_call\s*\n[\s\S]*?\n```/gi, '')
    .replace(/Tool call for\s+[a-z_]+:\s*\{[\s\S]*?\}\s*(?=\n[A-Z]|\n[a-zA-Z][^\n]*:|$)/gi, '');
}

function stripLegacyAgentFallbackDiagnostics(content: string): string {
  if (!content) return content;
  const normalized = content.replace(/\r\n?/g, '\n');
  const hasLegacyAgentFallback =
    /Agent stopped:/i.test(normalized) ||
    /during the agent loop/i.test(normalized) ||
    /returned only gathered evidence/i.test(normalized);
  if (!hasLegacyAgentFallback) return content;

  const lines = normalized.split('\n');
  const keep: string[] = [];
  let skipping = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    const legacyHeaderLine =
      /^>\s*\*\*agent stopped:\*\*/i.test(line) ||
      /^agent stopped:\s*/i.test(line);
    const startsLegacySection =
      lower === '## sources found' ||
      lower === '## tool evidence' ||
      lower === '## tool failures' ||
      lower.startsWith('search query:') ||
      lower.startsWith('context excerpt:');

    if (legacyHeaderLine) {
      continue;
    }

    if (startsLegacySection) {
      skipping = true;
      continue;
    }

    if (skipping && /^(agent stopped because|what was completed:|what is missing:)/i.test(line)) {
      skipping = false;
    }

    if (skipping && /^##\s+/.test(line)) {
      skipping = false;
    }

    if (skipping) continue;
    keep.push(rawLine);
  }

  return keep.join('\n');
}

function stripTranscriptPrefix(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const markerCount = lines.filter((line) => TRANSCRIPT_MARKER_RE.test(line)).length;

  // Only a leaked agent transcript ("Thought for 3s", "Using: …") has a
  // preamble to drop. Without its markers, an opening like "I can help
  // with:" or "Let me explain" IS the answer, list and all.
  if (markerCount < 2) return content;

  let index = 0;
  let skippingMetaBlock = false;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const isMarker = TRANSCRIPT_MARKER_RE.test(line);
    const isMeta = META_LINE_RE.test(line);
    const isListCarry: boolean = skippingMetaBlock && (/^\d+[.)]\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed) || trimmed === '');
    const isNoiseNumber: boolean = /^\d+$/.test(trimmed) && index < lines.length - 1;

    if (isMarker || isMeta || isListCarry || isNoiseNumber) {
      skippingMetaBlock = isMeta || isListCarry;
      index += 1;
      continue;
    }

    break;
  }

  return lines.slice(index).join('\n');
}

function tidy(content: string): string {
  return content
    .replace(/^\s*\|\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeAssistantVisibleText(content: string): string {
  if (!content) return '';
  const withoutPayloads = stripToolPayloads(content).replace(DEBUG_LINE_RE, '');
  const visible = tidy(stripTranscriptPrefix(stripLegacyAgentFallbackDiagnostics(withoutPayloads)));
  // Cleaning up must never blank a reply the model did write.
  return visible || tidy(withoutPayloads);
}
