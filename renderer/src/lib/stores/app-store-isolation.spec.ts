import { describe, expect, it } from 'vitest';
import {
  isDefaultChatTitle,
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
  it('normalizes context modes and migrates every legacy spelling', () => {
    expect(normalizeContextMode('home')).toBe('home');
    expect(normalizeContextMode('code')).toBe('code');
    // Legacy ids: 'chat' was the old home id; 'work' the old code id.
    expect(normalizeContextMode('chat')).toBe('home');
    expect(normalizeContextMode('work')).toBe('code');
    expect(normalizeContextMode(undefined)).toBe('home');
    expect(normalizeContextMode('nope')).toBe('home');
  });

  it('migrates workspace-backed chat sessions to code once', () => {
    expect(resolveImmutableContextMode({ contextMode: 'chat' as never, workspace: sampleWorkspace })).toBe('code');
    expect(resolveImmutableContextMode({ contextMode: 'chat' as never })).toBe('home');
    expect(resolveImmutableContextMode({ contextMode: 'code', workspace: sampleWorkspace })).toBe('code');
    expect(resolveImmutableContextMode({ contextMode: 'work' as never })).toBe('code');
  });

  it('defaults composer mode by space when unset', () => {
    expect(normalizeSessionComposerMode(undefined, 'home')).toBe('agent');
    expect(normalizeSessionComposerMode(undefined, 'code')).toBe('agent');
    expect(normalizeSessionComposerMode('chat', 'code')).toBe('chat');
    expect(normalizeSessionComposerMode('agent', 'home')).toBe('agent');
    expect(normalizeSessionComposerMode('ask', 'home')).toBe('ask');
  });

  it('normalizes search mode', () => {
    expect(normalizeSessionSearchMode('deep')).toBe('deep');
    expect(normalizeSessionSearchMode(undefined)).toBe('chat');
    expect(normalizeSessionSearchMode('bogus')).toBe('chat');
  });

  it('recognizes every default title a send may replace', () => {
    for (const title of ['New chat', 'New session', 'New work', 'New code', 'New conversation', 'New Work', 'Codebase overview']) {
      expect(isDefaultChatTitle(title)).toBe(true);
    }
    expect(isDefaultChatTitle('Fix the login bug')).toBe(false);
    expect(isDefaultChatTitle('')).toBe(false);
  });

  it('normalizeChat freezes identity and preserves per-chat modes', () => {
    const chat = normalizeChat(
      {
        id: 'c1',
        title: 'Research',
        contextMode: 'chat' as never,
        workspace: sampleWorkspace,
        composerMode: 'chat',
        searchMode: 'deep',
        reasoningLevel: 'high',
        messages: []
      },
      0
    ) as ChatSession;

    expect(chat.contextMode).toBe('code');
    expect(chat.composerMode).toBe('chat');
    expect(chat.searchMode).toBe('deep');
    expect(chat.reasoningLevel).toBe('high');
    expect(chat.codeAgent).toBeNull();
  });

  it('normalizeChat migrates legacy sessions to code and preserves agent identity', () => {
    // Code space conversations must keep their project link + engine
    // session meta through hydration — resume depends on both surviving.
    const migrated = normalizeChat({ id: 'k1', contextMode: 'code' as never, projectId: 'p1', messages: [] }, 0);
    expect(migrated.contextMode).toBe('code');
    expect(migrated.projectId).toBe('p1');
    expect(migrated.composerMode).toBe('agent');

    const legacyWork = normalizeChat({ id: 'w1', contextMode: 'work' as never, projectId: 'p3', messages: [] }, 0);
    expect(legacyWork.contextMode).toBe('code');

    const agent = normalizeChat(
      {
        id: 'a1',
        contextMode: 'code',
        projectId: 'p2',
        codeAgent: { instanceId: 'agente', driverKind: 'agente', substrate: 'native', updatedAt: 1 },
        messages: []
      },
      0
    );
    expect(agent.projectId).toBe('p2');
    expect(agent.codeAgent?.sessionId).toBeUndefined();
    expect(agent.codeAgent?.driverKind).toBe('agente');

    const plain = normalizeChat({ id: 'c2', contextMode: 'chat' as never, messages: [] }, 1);
    expect(plain.contextMode).toBe('home');
    expect(plain.codeAgent).toBeNull();
    expect(plain.projectId).toBeNull();
    // New Home chats default to Agent (explicit product choice); stored modes
    // — including 'chat' and 'ask' — are always preserved (see above).
    expect(plain.composerMode).toBe('agent');
  });
});
