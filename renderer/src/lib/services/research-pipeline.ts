import type { SearchResult } from '$lib/types/tauri';
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

export function researchSynthesisUserNudge(mode: ResearchMode, medical: boolean, attempt: number, maxAttempts: number): string {
  const depth =
    mode === 'max'
      ? 'Write a comprehensive MAX research report for professional readers.'
      : mode === 'deep'
        ? 'Write a thorough DEEP research report for people who will use the findings at work.'
        : 'Write a focused SEARCH-mode professional brief (still a real report, not a bullet dump).';

  const attemptLine =
    attempt === 1
      ? 'You have finished gathering sources. Do NOT call tools.'
      : `Synthesis attempt ${attempt}/${maxAttempts}. Do NOT call tools. Write the full report now.`;

  return [
    attemptLine,
    depth,
    'Using ONLY the RESEARCH EVIDENCE PACK (and any prior tool results), produce a full professional research report following APA 7th edition — not a summary, not a tool log, not notes.',
    'Forbidden: dumping the pack; listing raw search hits; sections titled "Gathered Evidence", "Summary", or "Executive Summary"; mentioning step limits, agents, or tools.',
    'Required skeleton: # Title (name the user\'s search topic); coherent topical ## sections with blank lines between paragraphs; ## Limitations; ## References in APA 7 web format.',
    'Cite with APA author–date when metadata exists; also use [n] for numbered sources. Never invent authors or dates; use (n.d.) when missing.',
    medical
      ? 'Medical topic: include a brief non-advice disclaimer; structure Definition; Epidemiology/presentation; Diagnosis; Treatment; Prognosis; Limitations; References.'
      : 'Structure for practitioners/analysts who work with this topic.'
  ].join('\n\n');
}
