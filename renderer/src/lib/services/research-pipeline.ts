import type { SearchResult } from '$lib/types/bridge';
import type { ToolObservation } from '$lib/services/agent-types';

export type ResearchMode = 'search' | 'deep' | 'max';

/** True for composer Search / Deep / Max product runs (not code agent). */
export function isResearchProductPath(params: {
  isCodeProfile?: boolean;
  toolMode?: string;
  searchMode?: string | null;
}): boolean {
  if (params.isCodeProfile) return false;
  const mode = params.searchMode || '';
  return (
    params.toolMode === 'search_chat'
    || mode === 'search'
    || mode === 'deep'
    || mode === 'max'
  );
}

export function resolveResearchMode(searchMode?: string | null): ResearchMode {
  if (searchMode === 'max') return 'max';
  if (searchMode === 'search') return 'search';
  if (searchMode === 'deep') return 'deep';
  return 'search';
}

export function researchEvidenceThreshold(mode: ResearchMode): {
  minSources: number;
  minRich: number;
  maxSearchRounds: number;
  resultBudget: number;
} {
  if (mode === 'max') {
    return { minSources: 10, minRich: 6, maxSearchRounds: 4, resultBudget: 18 };
  }
  if (mode === 'deep') {
    return { minSources: 6, minRich: 4, maxSearchRounds: 3, resultBudget: 12 };
  }
  return { minSources: 4, minRich: 2, maxSearchRounds: 2, resultBudget: 8 };
}

function bodyLen(source: SearchResult): number {
  return String(source.full_content || source.snippet || '').trim().length;
}

/** Enough material to write a real report instead of more SERP thrashing. */
export function hasEnoughResearchEvidence(mode: ResearchMode, sources: SearchResult[]): boolean {
  const threshold = researchEvidenceThreshold(mode);
  const list = Array.isArray(sources) ? sources : [];
  const rich = list.filter((source) => bodyLen(source) >= 120).length;
  return list.length >= threshold.minSources || rich >= threshold.minRich;
}

export function countSuccessfulSearchRounds(observations: ToolObservation[]): number {
  return (observations || []).filter((o) => o.name === 'web_search' && o.success).length;
}

export function shouldForceResearchSynthesis(params: {
  mode: ResearchMode;
  sources: SearchResult[];
  observations: ToolObservation[];
}): boolean {
  if (!hasEnoughResearchEvidence(params.mode, params.sources)) return false;
  const rounds = countSuccessfulSearchRounds(params.observations);
  const maxRounds = researchEvidenceThreshold(params.mode).maxSearchRounds;
  // Force write once we have enough sources, or once search rounds hit the cap.
  return rounds >= 1 && (hasEnoughResearchEvidence(params.mode, params.sources) || rounds >= maxRounds);
}

/** Soft copy when sources are thin — never "step limit / agent error". */
export function researchThinSourcesNotice(sourceCount: number, richCount: number): string | undefined {
  if (sourceCount === 0) return 'No live sources could be retrieved for this query.';
  if (richCount < 2) {
    return 'Some pages could not be fully read (blocked or thin content). Findings below use what was available.';
  }
  return undefined;
}

/**
 * The "stop searching, start writing" prompt.
 *
 * Deliberately says nothing about output shape: the format contract already
 * arrived with the system prompt, and callers append
 * `FINAL_ANSWER_CONTRACT_REMINDER` after this. This function used to restate the
 * whole skeleton — one of six places that did, in a single request.
 */
export function researchSynthesisUserNudge(
  mode: ResearchMode,
  medical: boolean,
  attempt: number,
  maxAttempts: number
): string {
  const depth =
    mode === 'max'
      ? 'Write the comprehensive MAX research report for professional readers.'
      : mode === 'deep'
        ? 'Write the thorough DEEP research report for people who will use the findings at work.'
        : 'Answer the question directly, at the length it deserves.';

  const attemptLine =
    attempt === 1
      ? 'You have finished gathering sources. Do NOT call tools.'
      : `Synthesis attempt ${attempt}/${maxAttempts}. Do NOT call tools. Write the answer now.`;

  return [
    attemptLine,
    depth,
    'Use ONLY the RESEARCH EVIDENCE PACK and prior tool results. Do not dump the pack, list raw search hits, or mention step limits, agents, or tools.',
    medical
      ? 'Medical topic: include a brief note that this is general information rather than personal medical advice, and prefer guideline or peer-reviewed sources.'
      : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}
