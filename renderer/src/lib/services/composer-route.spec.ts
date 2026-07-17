import { describe, expect, it } from 'vitest';
import { resolveComposerRoute, shouldUseToolLoop } from '$lib/services/composer-route';

describe('resolveComposerRoute', () => {
  it('routes greetings to conversation', () => {
    expect(resolveComposerRoute({ prompt: 'Hello!' })).toBe('conversation');
    expect(resolveComposerRoute({ prompt: 'thanks' })).toBe('conversation');
  });

  it('routes weather and FX to tools', () => {
    expect(resolveComposerRoute({ prompt: 'What is the weather in Madrid?' })).toBe('tools');
    expect(resolveComposerRoute({ prompt: 'Convert 100 USD to EUR' })).toBe('tools');
    expect(resolveComposerRoute({ prompt: 'AAPL price' })).toBe('tools');
  });

  it('routes file/build work to agent', () => {
    expect(resolveComposerRoute({ prompt: 'Create a spreadsheet with budget rows' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Fix the bug in this code' })).toBe('agent');
  });

  it('forces tools for search modes and attachments', () => {
    expect(resolveComposerRoute({ prompt: 'hello', searchMode: 'deep' })).toBe('tools');
    expect(resolveComposerRoute({ prompt: 'summarize', hasAttachments: true })).toBe('tools');
  });

  it('forces agent in work context', () => {
    expect(resolveComposerRoute({ prompt: 'hi', contextMode: 'work' })).toBe('agent');
  });
});

describe('shouldUseToolLoop', () => {
  it('auto only loops for tools/agent routes', () => {
    expect(shouldUseToolLoop({
      control: 'auto',
      composerMode: 'chat',
      route: 'conversation'
    })).toBe(false);
    expect(shouldUseToolLoop({
      control: 'auto',
      composerMode: 'chat',
      route: 'tools'
    })).toBe(true);
  });

  it('tabs agent always uses tools', () => {
    expect(shouldUseToolLoop({
      control: 'tabs',
      composerMode: 'agent',
      route: 'conversation'
    })).toBe(true);
  });
});
