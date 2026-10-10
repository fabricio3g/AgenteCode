/**
 * Pure helpers for design systems: the name a system is saved under, the
 * colour swatches it shows without a specimen page, and the section the design
 * agent is briefed with. Main owns the files; this only shapes what is shown
 * and sent.
 */
import type { DesignSystemBrief } from '$shared/design';
import { parseTokens, tokensFor } from './design-tokens';

export const SYSTEM_NAME_MAX = 60;
export const SYSTEM_DESCRIPTION_MAX = 200;

/** The name a system is saved under, or null when nothing is left to save. Main applies the same rule. */
export function cleanSystemName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, SYSTEM_NAME_MAX);
  return name || null;
}

/** The first colours a tokens file declares for the light scheme, for a swatch row. */
export function systemSwatches(tokensCss: string, limit = 6): string[] {
  return tokensFor(parseTokens(tokensCss), 'light')
    .filter((decl) => decl.group === 'color')
    .slice(0, limit)
    .map((decl) => decl.value.trim());
}

const BRIEF_CHARS = 6000;
const cap = (text: string) => (text.length > BRIEF_CHARS ? `${text.slice(0, BRIEF_CHARS)}\n…(truncated)` : text);

/** The system section of the design agent's briefing; empty when the design uses no system. */
export function systemBriefing(brief: DesignSystemBrief | null): string {
  if (!brief) return '';
  const parts = [
    `## Design system: ${brief.name}`,
    'This design uses the system above. Obey its guidance and tokens: reuse its tokens, extend tokens.css when a token is missing, and never hard-code a value the system already defines.'
  ];
  if (brief.designMd) parts.push('### DESIGN.md (system)', cap(brief.designMd));
  if (brief.tokens) parts.push('### tokens.css (system)', cap(brief.tokens));
  return parts.join('\n\n');
}
