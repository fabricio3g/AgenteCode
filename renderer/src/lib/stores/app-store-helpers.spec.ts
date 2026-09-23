import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from '$lib/types/chat';
import { markAgentStopped, normalizeChat, normalizeSessionComposerMode, optimisticAck, reliableUsageMetadata, repairRoleplayChat } from '$lib/stores/app-store-helpers';

describe('normalizeSessionComposerMode', () => {
  it('preserves instant alongside agent', () => {
    expect(normalizeSessionComposerMode('instant', 'home')).toBe('instant');
    expect(normalizeSessionComposerMode('agent', 'home')).toBe('agent');
  });

  it('migrates legacy chat (and pre-merge ask) to instant', () => {
    expect(normalizeSessionComposerMode('chat', 'home')).toBe('instant');
    expect(normalizeSessionComposerMode('ask', 'home')).toBe('instant');
  });

  it('forces the full loop on code space', () => {
    expect(normalizeSessionComposerMode(undefined, 'code')).toBe('agent');
    expect(normalizeSessionComposerMode('chat', 'code')).toBe('agent');
    expect(normalizeSessionComposerMode('instant', 'code')).toBe('agent');
  });

  it('keeps roleplay on the direct-stream chat mode', () => {
    expect(normalizeSessionComposerMode('chat', 'roleplay')).toBe('chat');
    expect(normalizeSessionComposerMode('instant', 'roleplay')).toBe('chat');
    expect(normalizeSessionComposerMode('agent', 'roleplay')).toBe('chat');
  });
});

describe('normalizeChat roleplay identity', () => {
  it('keeps character, persona, world and roster inside roleplay', () => {
    const chat = normalizeChat({
      id: 'chat-roleplay',
      contextMode: 'roleplay',
      characterId: 'char-1',
      worldId: 'world-1',
      personaId: 'persona-1',
      greetingIndex: 2,
      searchMode: 'deep',
      roleplay: { characterIds: ['char-1'] }
    }, 0);

    expect(chat.contextMode).toBe('roleplay');
    expect(chat.characterId).toBe('char-1');
    expect(chat.worldId).toBe('world-1');
    expect(chat.personaId).toBe('persona-1');
    expect(chat.greetingIndex).toBe(2);
    expect(chat.roleplay?.characterIds).toEqual(['char-1']);
    // Roleplay has no web search modes.
    expect(chat.searchMode).toBe('chat');
  });

  it('strips roleplay fields from other spaces', () => {
    const chat = normalizeChat({ id: 'chat-home', contextMode: 'home', characterId: 'char-1', worldId: 'world-1' }, 0);
    expect(chat.characterId).toBeNull();
    expect(chat.worldId).toBeNull();
    expect(chat.roleplay).toBeNull();
  });
});

describe('repairRoleplayChat', () => {
  function roleplayChat(overrides: Partial<ChatSession> = {}): ChatSession {
    return normalizeChat({ id: 'chat-1', contextMode: 'roleplay', messages: [], ...overrides }, 0);
  }

  it('adopts the character and roster from attributed turns', () => {
    const chat = roleplayChat({
      messages: [
        { id: 'm1', role: 'assistant', content: 'Hi.', speakerId: 'char-aiko' },
        { id: 'm2', role: 'user', content: 'Hello.' },
        { id: 'm3', role: 'assistant', content: 'Ren here.', speakerId: 'char-ren' }
      ] as ChatMessage[]
    });

    const repaired = repairRoleplayChat(chat);
    expect(repaired.characterId).toBe('char-aiko');
    expect(repaired.roleplay?.characterIds).toEqual(['char-aiko', 'char-ren']);
  });

  it('leaves narrator openings and complete scenes untouched', () => {
    const narrator = roleplayChat({
      messages: [{ id: 'm1', role: 'assistant', content: 'The lanterns rise.' }] as ChatMessage[]
    });
    expect(repairRoleplayChat(narrator)).toBe(narrator);

    const complete = roleplayChat({ characterId: 'char-aiko', roleplay: { characterIds: ['char-aiko'] } });
    expect(repairRoleplayChat(complete)).toBe(complete);
  });

  it('does not touch other spaces', () => {
    const home = normalizeChat({ id: 'home-1', contextMode: 'home' }, 0);
    expect(repairRoleplayChat(home)).toBe(home);
  });
});

describe('optimisticAck', () => {
  it('echoes the request with a work verb for builds', () => {
    expect(optimisticAck('Build me a doc file with a poem', 'work')).toBe('On it — Build me a doc file with a poem');
  });

  it('uses a lookup verb for grounded questions', () => {
    expect(optimisticAck('Weather in Paris?', 'lookup')).toBe('Looking into it — Weather in Paris?');
  });

  it('truncates long prompts and stays silent on empty ones', () => {
    expect(optimisticAck('x'.repeat(200), 'work')).toBe(`On it — ${'x'.repeat(87)}…`);
    expect(optimisticAck('   ', 'work')).toBe('');
  });
});

describe('assistant runtime usage metadata', () => {
  it('uses llama.cpp completion tokens and generation speed instead of total wall time', () => {
    const metadata = reliableUsageMetadata({
      prompt_tokens: 137,
      completion_tokens: 276,
      total_tokens: 413,
      timings: {
        prompt_ms: 1200,
        predicted_ms: 5000,
        predicted_per_second: 55.2
      }
    }, 14.7, 'runtime');

    expect(metadata).toMatchObject({
      usageSource: 'runtime',
      inputTokens: 137,
      outputTokens: 276,
      totalTokens: 413,
      tokens: 276,
      timing: 5,
      modelTimingSeconds: 5,
      tokensPerSecond: 55.2,
      promptEvalTimingSeconds: 1.2
    });
  });

  it('does not label request wall time as model timing when runtime timings are absent', () => {
    const metadata = reliableUsageMetadata({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14
    }, 14.7, 'runtime');

    expect(metadata?.outputTokens).toBe(4);
    expect(metadata?.timing).toBeUndefined();
    expect(metadata?.modelTimingSeconds).toBeUndefined();
    expect(metadata?.tokensPerSecond).toBeUndefined();
  });
});

describe('stopped agent presentation', () => {
  it('removes a planning-only step when the run is stopped before tools start', () => {
    const message = {
      agentSteps: [{
        id: 'step-1',
        type: 'thinking',
        label: 'Planning',
        status: 'running',
        detail: 'Step 1 of 10'
      }]
    } as ChatMessage;

    markAgentStopped(message);

    expect(message.agentSteps).toEqual([]);
  });

  it('keeps completed tool work while marking the active step stopped', () => {
    const message = {
      agentSteps: [
        { id: 'step-1', type: 'tool', label: 'Search', status: 'done' },
        { id: 'step-2', type: 'thinking', label: 'Planning', status: 'running', detail: 'Step 2 of 10' }
      ]
    } as ChatMessage;

    markAgentStopped(message);

    expect(message.agentSteps).toMatchObject([
      { label: 'Search', status: 'done' },
      { label: 'Stopped', status: 'done', detail: 'Stopped by user' }
    ]);
  });
});
