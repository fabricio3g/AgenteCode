/**
 * The two top-level spaces of the app.
 *
 * Every session (chat) belongs to exactly one space, and a space decides what
 * the UI offers and what the model may do:
 *
 * - `home` — the general assistant surface: conversation, research,
 *   investigation, documents, search. No filesystem access, no project tools.
 * - `code` — the coding agent surface: project folders, workspace tools,
 *   file edits, checkpoints. Coding work only.
 *
 * This module is the single source of truth for that split. Components read
 * labels and defaults from here; services consult it instead of hard-coding
 * space checks.
 */

export type SpaceId = 'home' | 'code';

export interface SpaceDefinition {
  id: SpaceId;
  /** Sidebar tab label. */
  label: string;
  /** One-line purpose statement, shown in tooltips / empty states. */
  description: string;
  /** Composer mode new sessions in this space start with. */
  defaultComposerMode: 'chat' | 'ask' | 'agent';
  /**
   * Agent profiles this space may run. The first entry is the default; the
   * agent tool loop only ever receives tools from these profiles.
   */
  agentProfiles: Array<'chat' | 'search' | 'work' | 'code'>;
  /** Search modes offered by the composer in this space. */
  searchModes: Array<'chat' | 'search' | 'deep' | 'max'>;
}

export const SPACES: Record<SpaceId, SpaceDefinition> = {
  home: {
    id: 'home',
    label: 'Home',
    description: 'Conversation, research and investigation — no code execution.',
    defaultComposerMode: 'agent',
    agentProfiles: ['chat', 'search'],
    searchModes: ['chat', 'search', 'deep', 'max']
  },
  code: {
    id: 'code',
    label: 'Code',
    description: 'The coding agent: projects, files, edits and checkpoints.',
    defaultComposerMode: 'agent',
    agentProfiles: ['code'],
    searchModes: ['chat']
  }
};

export const SPACE_IDS: readonly SpaceId[] = ['home', 'code'];

/**
 * Map any persisted or legacy value onto a valid SpaceId.
 *
 * History of the persisted values:
 * - `'chat'` was the original id of the Home space.
 * - `'work'` was the original id of the Code space.
 * - `'code'` briefly named the Code space before the 'work' era, then was
 *   migrated back to 'work'; both spellings mean the same space.
 */
export function normalizeSpace(value: unknown): SpaceId {
  if (value === 'work' || value === 'code') return 'code';
  return 'home';
}
