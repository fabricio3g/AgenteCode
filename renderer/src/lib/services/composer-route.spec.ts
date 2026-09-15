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

  it('routes visual deliverables to agent so the tool loop can build them', () => {
    expect(resolveComposerRoute({ prompt: 'Show me a map of Madrid' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Make a bar chart of sales by quarter' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Draw a flowchart of the login flow' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Build a KPI dashboard for the team' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Create an HTML card for pricing' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Chart my expenses' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'Plot the results' })).toBe('agent');
  });

  it('keeps non-deliverable lookalikes in conversation', () => {
    expect(resolveComposerRoute({ prompt: 'Map these fields to the new schema' })).toBe('conversation');
    expect(resolveComposerRoute({ prompt: 'What is the plot of Dune?' })).toBe('conversation');
    expect(resolveComposerRoute({ prompt: 'Draw a conclusion from the data' })).toBe('conversation');
  });

  it('forces tools for search modes and attachments', () => {
    expect(resolveComposerRoute({ prompt: 'hello', searchMode: 'deep' })).toBe('tools');
    expect(resolveComposerRoute({ prompt: 'summarize', hasAttachments: true })).toBe('tools');
  });

  it('forces agent in the code space', () => {
    expect(resolveComposerRoute({ prompt: 'hi', contextMode: 'code' })).toBe('agent');
  });

  it('normalizes legacy space spellings before routing', () => {
    expect(resolveComposerRoute({ prompt: 'hi', contextMode: 'work' })).toBe('agent');
    expect(resolveComposerRoute({ prompt: 'hi', contextMode: 'chat' })).not.toBe('agent');
  });
});

describe('shouldUseToolLoop', () => {
  it('Home always offers tools, including ordinary chat and keyword-free follow-ups', () => {
    expect(shouldUseToolLoop({
      control: 'auto',
      composerMode: 'chat',
      route: 'conversation'
    })).toBe(true);
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

  it('code space always loops, including legacy spellings', () => {
    expect(shouldUseToolLoop({
      control: 'auto',
      composerMode: 'chat',
      route: 'conversation',
      contextMode: 'code'
    })).toBe(true);
    expect(shouldUseToolLoop({
      control: 'auto',
      composerMode: 'chat',
      route: 'conversation',
      contextMode: 'work'
    })).toBe(true);
    expect(shouldUseToolLoop({
      control: 'auto',
      composerMode: 'chat',
      route: 'conversation',
      contextMode: 'home'
    })).toBe(true);
  });
});
