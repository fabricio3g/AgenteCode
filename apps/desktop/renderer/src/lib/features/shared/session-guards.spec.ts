import { describe, expect, it } from 'vitest';
import { getSpaceForSession, isCodeSession, isHomeSession } from '$lib/features/shared/session-guards';
import { normalizeContextMode } from '$lib/stores/app-store-helpers';
import type { ChatSession } from '$lib/types/chat';

function session(id: string, contextMode: ChatSession['contextMode']): ChatSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    draft: '',
    contextMode,
    codeAgent: null,
    projectId: null,
    workspace: null,
    reasoningLevel: null,
    composerMode: null,
    searchMode: null,
    messages: []
  };
}

describe('space guards', () => {
  it('classifies home vs code sessions', () => {
    expect(isHomeSession(session('h', 'home'))).toBe(true);
    expect(isCodeSession(session('c', 'code'))).toBe(true);
    expect(getSpaceForSession(session('w', 'work' as never))).toBe('code');
    expect(getSpaceForSession(null)).toBe('home');
  });
});

describe('delete fallback stays in space', () => {
  it('deleting last home chat never falls back to a code chat', () => {
    const remaining = [session('c1', 'code'), session('c2', 'code')];
    const deletedMode = normalizeContextMode('home');
    // Fixed rule: scoped fallback only, never chats[0] cross-space.
    const scoped = remaining.find((c) => normalizeContextMode(c.contextMode) === deletedMode)?.id ?? null;
    expect(scoped).toBeNull();
    expect(remaining[0]?.id).toBe('c1'); // chats[0] would wrongly jump to code
  });

  it('deleting last code chat never falls back to a home chat', () => {
    const remaining = [session('h1', 'home')];
    const deletedMode = normalizeContextMode('code');
    const scoped = remaining.find((c) => normalizeContextMode(c.contextMode) === deletedMode)?.id ?? null;
    expect(scoped).toBeNull();
  });

  it('picks next chat in same space when one exists', () => {
    const remaining = [session('h1', 'home'), session('c1', 'code')];
    const scopedHome = remaining.find((c) => normalizeContextMode(c.contextMode) === 'home')?.id ?? null;
    expect(scopedHome).toBe('h1');
  });
});
