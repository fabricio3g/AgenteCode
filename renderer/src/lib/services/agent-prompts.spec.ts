import { describe, expect, it } from 'vitest';
import {
  buildCurrentRequestReminder,
  buildDirectSystemPrompt,
  getXmlSystemPrompt
} from '$lib/services/agent-prompts';
import { compactText } from '$lib/services/agent-evidence';

describe('agent-prompts', () => {
  it('buildCurrentRequestReminder keeps the active request prominent', () => {
    const reminder = buildCurrentRequestReminder('Keep the answer short and create a docx.', compactText);

    expect(reminder).toContain('CURRENT USER REQUEST');
    expect(reminder).toContain('Keep the answer short and create a docx.');
  });

  it('buildDirectSystemPrompt appends extra instructions once', () => {
    const prompt = buildDirectSystemPrompt('Extra agent context');

    expect(prompt).toContain("Respond directly to the user's request.");
    expect(prompt).toContain('Extra agent context');
  });

  it('getXmlSystemPrompt includes tool inventory and limits', () => {
    const prompt = getXmlSystemPrompt('Extra context', 7, 4, [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      }
    ]);

    expect(prompt).toContain('web_search(query) - Search the web');
    expect(prompt).toContain('4 reasoning steps');
    expect(prompt).toContain('7 tool calls');
    expect(prompt).toContain('Extra context');
  });
});
