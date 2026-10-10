/** Extract JSON from a completed model response. No network or UI dependencies. */

export interface StructuredExtractionResult<T = Record<string, unknown>> {
  data: T | null;
  raw: string;
  parsed: boolean;
  error?: string;
}

export function extractJsonFromResponse<T = Record<string, unknown>>(raw: string): StructuredExtractionResult<T> {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return { data: null, raw: trimmed, parsed: false, error: 'Empty response' };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    return { data, raw: trimmed, parsed: true };
  } catch {
    // Continue to extraction strategies
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const data = JSON.parse(codeBlockMatch[1].trim()) as T;
      return { data, raw: trimmed, parsed: true };
    } catch {
      // Continue
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const data = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
      return { data, raw: trimmed, parsed: true };
    } catch {
      // Continue
    }
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const data = JSON.parse(trimmed.slice(firstBracket, lastBracket + 1)) as T;
      return { data, raw: trimmed, parsed: true };
    } catch {
      // Continue
    }
  }

  return { data: null, raw: trimmed, parsed: false, error: 'Could not extract valid JSON from response' };
}

