// The core's thinking profile in the renderer's vocabulary. Pure, so tests
// can exercise it without Electron (thinking.ts talks to the daemon).

import type { ReasoningCapabilities, ReasoningLevel } from '../providers/base.ts';

/** `agente_core::thinking::ThinkingProfile` as the daemon sends it. */
export type ThinkingProfile = {
  /** Concrete choices, low → high; Auto is implied. */
  levels: Array<{ id: string; budget_tokens?: number }>;
  default?: string;
  mandatory: boolean;
  source: 'catalog' | 'live' | 'template' | 'none';
};

export const UNKNOWN_CAPABILITIES: ReasoningCapabilities = { supported: false, levels: [], source: 'unknown' };

function offersThinking(profile: ThinkingProfile): boolean {
  return profile.source !== 'none' && (profile.levels.length > 0 || profile.mandatory);
}

export function capabilitiesFromProfile(profile: ThinkingProfile): ReasoningCapabilities {
  const levels = profile.levels.map((level) => level.id as ReasoningLevel);
  if (!offersThinking(profile)) return UNKNOWN_CAPABILITIES;
  return {
    // Auto plus at least one level makes a choice.
    supported: levels.length > 0,
    levels,
    source: profile.source,
    ...(profile.default ? { default: profile.default as ReasoningLevel } : {}),
    mandatory: profile.mandatory,
    // Only real token budgets: a level without one is sized by the provider,
    // which is not the same as unlimited, so it shows nothing.
    budgets: Object.fromEntries(
      profile.levels.flatMap((level) => (level.budget_tokens === undefined ? [] : [[level.id, level.budget_tokens]]))
    )
  };
}
