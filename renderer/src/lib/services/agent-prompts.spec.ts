import { describe, expect, it } from 'vitest';
import {
  buildCurrentRequestReminder,
  buildDirectSystemPrompt,
  buildResearchFinalAnswerContract,
  buildResearchReportInstruction,
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

  it('buildDirectSystemPrompt preserves research instructions for max search fallback', () => {
    const prompt = buildDirectSystemPrompt('Extra research context', {
      toolMode: 'search_chat',
      searchMode: 'max'
    });

    expect(prompt).toContain('MAX research');
    expect(prompt).toContain('Do not answer generically when evidence is available');
    expect(prompt).toContain('Do not add boilerplate filler');
    expect(prompt).toContain('search topic');
    expect(prompt).toContain('source excerpts, source titles, and URLs');
    expect(prompt).toContain('APA 7');
    expect(prompt).toContain('## References');
    expect(prompt).not.toMatch(/## Executive Summary/);
    expect(prompt).toContain('Extra research context');
  });

  it('buildDirectSystemPrompt applies APA contract for search and deep modes', () => {
    const search = buildDirectSystemPrompt(undefined, { toolMode: 'search_chat', searchMode: 'search' });
    const deep = buildDirectSystemPrompt(undefined, { toolMode: 'search_chat', searchMode: 'deep' });

    expect(search).toContain('SEARCH mode');
    expect(search).toContain('APA 7');
    expect(search).toContain('blank line');
    expect(deep).toContain('DEEP research');
    expect(deep).toContain('search topic');
    expect(deep).toContain('(n.d.)');
    expect(deep).not.toMatch(/## Executive Summary/);
  });

  it('getXmlSystemPrompt includes tool inventory, limits, and APA research contract for search_chat', () => {
    const prompt = getXmlSystemPrompt('Extra context', 7, 4, [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      }
    ], 'search_chat');

    expect(prompt).toContain('web_search(query) - Search the web');
    expect(prompt).toContain('4 reasoning steps');
    expect(prompt).toContain('7 tool calls');
    expect(prompt).toContain('APA 7');
    expect(prompt).toContain('search topic');
    expect(prompt).toContain('Extra context');
  });

  it('getXmlSystemPrompt includes tool inventory and limits for agent mode', () => {
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

  describe('buildResearchReportInstruction APA 7 contract', () => {
    for (const mode of ['search', 'deep', 'max'] as const) {
      it(`includes shared APA 7 + spacing rules for ${mode}`, () => {
        const text = buildResearchReportInstruction(mode, false);
        expect(text).toContain('APA 7');
        expect(text).toContain('search topic');
        expect(text).toContain('## References');
        expect(text).toContain('(n.d.)');
        expect(text).toMatch(/blank line/i);
        expect(text).toContain('Never invent');
        expect(text).toContain('Gathered Evidence');
        expect(text).toMatch(/Do NOT use sections named "Summary"/i);
        expect(text).not.toMatch(/^2\. ## Executive Summary/m);
      });
    }

    it('scales depth for search, deep, and max', () => {
      const search = buildResearchReportInstruction('search', false);
      const deep = buildResearchReportInstruction('deep', false);
      const max = buildResearchReportInstruction('max', false);

      expect(search).toContain('SEARCH mode');
      expect(search).toContain('2–4 focused body sections');
      expect(deep).toContain('DEEP research');
      expect(deep).toContain('thorough');
      expect(max).toContain('MAX research');
      expect(max).toContain('Methodology / Evidence Quality');
      expect(max).toContain('Unresolved Gaps');
    });

    it('keeps medical clinical structure with APA References', () => {
      const medical = buildResearchReportInstruction('deep', true);
      expect(medical).toContain('Epidemiology');
      expect(medical).toContain('pathophysiology');
      expect(medical).toContain('differential diagnosis');
      expect(medical).toContain('References');
      expect(medical).toContain('personal medical advice');
    });

    it('buildResearchFinalAnswerContract matches non-medical instruction', () => {
      expect(buildResearchFinalAnswerContract('deep')).toBe(
        buildResearchReportInstruction('deep', false)
      );
    });
  });
});
