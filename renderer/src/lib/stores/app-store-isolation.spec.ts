import { describe, expect, it } from 'vitest';
import {
  normalizeChat,
  normalizeContextMode,
  normalizeSessionComposerMode,
  normalizeSessionSearchMode,
  resolveImmutableContextMode
} from '$lib/stores/app-store-helpers';
import type { ChatSession, WorkspaceContext } from '$lib/types/chat';

const sampleWorkspace: WorkspaceContext = {
  rootName: 'demo',
  rootPath: 'D:/demo',
  attachedAt: 1,
  fileCount: 1,
  indexedCount: 1,
  skippedCount: 0,
  files: []
};

describe('space isolation helpers', () => {
  it('normalizes context modes and migrates legacy code to work', () => {
    expect(normalizeContextMode('work')).toBe('work');
    expect(normalizeContextMode('code' as unknown as string)).toBe('work');
    expect(normalizeContextMode('chat')).toBe('chat');
    expect(normalizeContextMode(undefined)).toBe('chat');
    expect(normalizeContextMode('nope')).toBe('chat');
  });

  it('migrates workspace-backed chat sessions to work once', () => {
    expect(resolveImmutableContextMode({ contextMode: 'chat', workspace: sampleWorkspace })).toBe('work');
    expect(resolveImmutableContextMode({ contextMode: 'chat' })).toBe('chat');
    expect(resolveImmutableContextMode({ contextMode: 'code' as 'work', workspace: sampleWorkspace })).toBe('work');
    expect(resolveImmutableContextMode({ contextMode: 'work' })).toBe('work');
  });

  it('defaults composer mode by space when unset', () => {
    expect(normalizeSessionComposerMode(undefined, 'chat')).toBe('chat');
    expect(normalizeSessionComposerMode(undefined, 'work')).toBe('agent');
    expect(normalizeSessionComposerMode('chat', 'work')).toBe('chat');
    expect(normalizeSessionComposerMode('agent', 'chat')).toBe('agent');
  });

  it('normalizes search mode', () => {
    expect(normalizeSessionSearchMode('deep')).toBe('deep');
    expect(normalizeSessionSearchMode(undefined)).toBe('chat');
    expect(normalizeSessionSearchMode('bogus')).toBe('chat');
  });

  it('normalizeChat freezes identity and preserves per-chat modes', () => {
    const chat = normalizeChat(
      {
        id: 'c1',
        title: 'Research',
        contextMode: 'chat',
        workspace: sampleWorkspace,
        composerMode: 'chat',
        searchMode: 'deep',
        reasoningLevel: 'high',
        messages: []
      },
      0
    ) as ChatSession;

    expect(chat.contextMode).toBe('work');
    expect(chat.composerMode).toBe('chat');
    expect(chat.searchMode).toBe('deep');
    expect(chat.reasoningLevel).toBe('high');
    expect(chat.codeAgent).toBeNull();
  });

  it('normalizeChat migrates legacy code sessions to work and preserves agente identity', () => {
    // Agente Coding conversations must keep their project link + engine
    // session meta through hydration — resume depends on both surviving.
    const migrated = normalizeChat({ id: 'k1', contextMode: 'code' as 'work', projectId: 'p1', messages: [] }, 0);
    expect(migrated.contextMode).toBe('work');
    expect(migrated.projectId).toBe('p1');
    expect(migrated.composerMode).toBe('agent');

    const agente = normalizeChat(
      {
        id: 'a1',
        contextMode: 'work',
        projectId: 'p2',
        codeAgent: { instanceId: 'agente', driverKind: 'agente', substrate: 'native', updatedAt: 1 },
        messages: []
      },
      0
    );
    expect(agente.projectId).toBe('p2');
    expect(agente.codeAgent?.sessionId).toBeUndefined();
    expect(agente.codeAgent?.driverKind).toBe('agente');

    const plain = normalizeChat({ id: 'c2', contextMode: 'chat', messages: [] }, 1);
    expect(plain.contextMode).toBe('chat');
    expect(plain.codeAgent).toBeNull();
    expect(plain.projectId).toBeNull();
    expect(plain.composerMode).toBe('chat');
  });
});
