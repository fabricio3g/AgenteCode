import { describe, expect, it } from 'vitest';
import {
  buildCurrentRequestReminder,
  buildDirectSystemPrompt,
  buildResearchFinalAnswerContract,
  buildResearchReportInstruction,
  getAgenteChatSystemPrompt,
  getNativeSystemPrompt,
  getXmlSystemPrompt
} from '$lib/services/agent-prompts';
import { compactText } from '$lib/services/agent-evidence';
import { parseXmlToolCall } from './agent-parsing';

describe('agent-prompts', () => {
  it('gives fallback models executable XML examples', () => {
    for (const mode of ['agent', 'search_chat'] as const) {
      const prompt = getXmlSystemPrompt(undefined, 12, 6, [], mode);
      const examples = [...prompt.matchAll(/<tool_call>[\s\S]*?<\/tool_call>/g)];
      expect(examples.length).toBeGreaterThan(0);
      for (const [example] of examples) expect(parseXmlToolCall(example).toolCall).not.toBeNull();
      expect(prompt).not.toMatch(/<\/?tool_call\n/);
    }
  });
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

  it('buildDirectSystemPrompt keeps citation rules in search mode without demanding a report', () => {
    const search = buildDirectSystemPrompt(undefined, { toolMode: 'search_chat', searchMode: 'search' });

    expect(search).toContain('Answer the question directly');
    expect(search).toContain('APA 7');
    expect(search).toContain('blank line');
    // Search mode must not impose the report skeleton on a short answer.
    expect(search).not.toMatch(/REQUIRED STRUCTURE/);
    expect(search).not.toMatch(/professional research report/);
  });

  it('buildDirectSystemPrompt applies the full report contract for deep mode', () => {
    const deep = buildDirectSystemPrompt(undefined, { toolMode: 'search_chat', searchMode: 'deep' });

    expect(deep).toContain('DEEP research');
    expect(deep).toContain('search topic');
    expect(deep).toContain('(n.d.)');
    expect(deep).toContain('REQUIRED STRUCTURE');
    expect(deep).not.toMatch(/## Executive Summary/);
  });

  it('getXmlSystemPrompt includes tool inventory, limits, and the final-answer contract for search_chat', () => {
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
    // Defaults to search mode, so the report skeleton must not be imposed.
    expect(prompt).toContain('Answer the question directly');
    expect(prompt).not.toMatch(/REQUIRED STRUCTURE/);
    expect(prompt).toContain('Extra context');
  });

  it('getXmlSystemPrompt includes tool inventory and limits for agent mode', () => {    const prompt = getXmlSystemPrompt('Extra context', 7, 4, [
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

  describe('buildResearchReportInstruction', () => {
    // Citation format, spacing, and the ban on dumping search results apply in
    // every mode. Only the *shape* of the answer varies by depth.
    for (const mode of ['search', 'deep', 'max'] as const) {
      it(`keeps the writing and citation rules for ${mode}`, () => {
        const text = buildResearchReportInstruction(mode, false);
        expect(text).toContain('APA 7');
        expect(text).toContain('## References');
        expect(text).toContain('(n.d.)');
        expect(text).toMatch(/blank line/i);
        expect(text).toContain('Never invent');
        expect(text).toContain('Gathered Evidence');
      });
    }

    it('lets a search-mode answer be as short as the question deserves', () => {
      const search = buildResearchReportInstruction('search', false);

      expect(search).toContain('Answer the question directly');
      expect(search).toMatch(/at the length the question deserves/i);
      // No mandatory title, sections, Limitations, or References.
      expect(search).not.toMatch(/REQUIRED STRUCTURE/);
      expect(search).not.toMatch(/professional research report/);
      expect(search).toMatch(/Include ## References only when you cited sources/);
      expect(search).toMatch(/Include ## Limitations only when evidence was thin/);
      expect(search).toMatch(/Never add it as a formality/);
    });

    it('keeps the full report contract for deep and max', () => {
      const deep = buildResearchReportInstruction('deep', false);
      const max = buildResearchReportInstruction('max', false);

      for (const text of [deep, max]) {
        expect(text).toContain('REQUIRED STRUCTURE');
        expect(text).toContain('search topic');
        expect(text).toContain('## Limitations');
        expect(text).toMatch(/Do NOT use sections named "Summary"/i);
      }

      expect(deep).toContain('DEEP research');
      expect(deep).toContain('thorough');
      expect(max).toContain('MAX research');
      expect(max).toContain('Methodology / Evidence Quality');
      expect(max).toContain('Unresolved Gaps');
    });

    it('keeps medical clinical structure with APA References in report modes', () => {
      const medical = buildResearchReportInstruction('deep', true);
      expect(medical).toContain('Epidemiology');
      expect(medical).toContain('pathophysiology');
      expect(medical).toContain('differential diagnosis');
      expect(medical).toContain('References');
      expect(medical).toContain('personal medical advice');
    });

    it('adds only a medical caveat in search mode, not a clinical outline', () => {
      const medical = buildResearchReportInstruction('search', true);
      expect(medical).toContain('personal medical advice');
      expect(medical).not.toContain('Epidemiology');
    });

    it('buildResearchFinalAnswerContract matches non-medical instruction', () => {
      for (const mode of ['search', 'deep', 'max'] as const) {
        expect(buildResearchFinalAnswerContract(mode)).toBe(
          buildResearchReportInstruction(mode, false)
        );
      }
    });
  });

  it('chat prompt mandates calling artifact tools instead of describing deliverables', () => {
    const prompt = getAgenteChatSystemPrompt();

    // The rule matters; the ALL-CAPS heading it used to live under does not.
    expect(prompt).toContain('call the matching tool with real arguments');
    expect(prompt).toContain('Describing it in prose is not delivering it');
    expect(prompt).not.toMatch(/must not replace or block the final answer/);
  });

  it('native sandbox prompt forbids prose substitutes for deliverables', () => {
    const prompt = getNativeSystemPrompt(undefined, 24, 12, 'agent', 'sandbox');

    expect(prompt).toContain('Describing it in prose is not delivering it');
  });

  it('XML agent prompt shows an artifact call example', () => {
    const prompt = getXmlSystemPrompt('Extra context', 7, 4, [
      {
        type: 'function',
        function: {
          name: 'create_chart',
          description: 'Create a chart',
          parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
        }
      }
    ]);

    expect(prompt).toContain('create_chart');
    expect(prompt).toMatch(/Describing it in prose is not delivering it/);
  });

  /*
   * The prompt asks the model to write plainly. It has to model that itself:
   * shouting is how these grew the policy-manual register the answers mirrored.
   */
  it('no prompt shouts a rule', () => {
    const prompts: Array<[string, string]> = [
      ['chat', getAgenteChatSystemPrompt()],
      ['native agent sandbox', getNativeSystemPrompt(undefined, 24, 12, 'agent', 'sandbox')],
      ['native agent workspace', getNativeSystemPrompt(undefined, 80, 28, 'agent', 'workspace')],
      ['native instant', getNativeSystemPrompt(undefined, 8, 4, 'instant')],
      ['native search', getNativeSystemPrompt(undefined, 24, 12, 'search_chat')],
      ['xml agent', getXmlSystemPrompt(undefined, 24, 12, [], 'agent', 'sandbox')],
      ['direct', buildDirectSystemPrompt(undefined)]
    ];
    const offenders = prompts.flatMap(([name, text]) =>
      ['MUST', 'NEVER', 'CRITICAL', 'IMPORTANT', 'ALWAYS']
        .filter((shout) => text.includes(shout))
        .map((shout) => `${name} shouts ${shout}`)
    );
    expect(offenders).toEqual([]);
  });

  /*
   * Minimal is a budget, not an intention. These ceilings are the real ones:
   * the base prompts were 3-5 KB of policy each before the rewrite.
   */
  it('keeps every prompt inside its budget', () => {
    // Ceilings sit just above today's sizes on purpose: the next addition has to
    // be argued for instead of silently joining a 5 KB wall of policy. The
    // sandbox and XML profiles are the largest because they carry the artifact
    // and report schemas, which are content contracts rather than style.
    const budgets: Array<[string, string, number]> = [
      ['chat', getAgenteChatSystemPrompt(), 1_700],
      ['native agent sandbox', getNativeSystemPrompt(undefined, 24, 12, 'agent', 'sandbox'), 4_300],
      ['native agent workspace', getNativeSystemPrompt(undefined, 80, 28, 'agent', 'workspace'), 1_050],
      ['native search', getNativeSystemPrompt(undefined, 24, 12, 'search_chat'), 4_200],
      ['xml agent sandbox', getXmlSystemPrompt(undefined, 24, 12, [], 'agent', 'sandbox'), 3_950]
    ];
    const over = budgets
      .filter(([, text, max]) => text.length > max)
      .map(([name, text, max]) => `${name}: ${text.length} bytes over ${max}`);
    expect(over).toEqual([]);
  });

  it('gives instant mode a lean direct-answer base with no artifact mandates', () => {
    const native = getNativeSystemPrompt(undefined, 8, 4, 'instant');
    expect(native).toMatch(/answer directly/i);
    expect(native).toMatch(/cannot create files or visuals/i);
    expect(native).not.toMatch(/MUST call/);
    expect(native).not.toMatch(/never an acceptable substitute/);

    const xml = getXmlSystemPrompt(undefined, 8, 4, [], 'instant');
    expect(xml).toMatch(/answer directly/i);
    expect(xml).toMatch(/cannot create files or visuals/i);
    expect(xml).not.toMatch(/create_chart/);
    expect(xml).not.toMatch(/never an acceptable substitute/);
  });

  it('opens agent turns with an acknowledgement first, never instant ones', () => {
    const agentNative = getNativeSystemPrompt(undefined, 24, 12, 'agent');
    expect(agentNative).toMatch(/one-line confirmation of what you understood/i);
    const agentXml = getXmlSystemPrompt(undefined, 24, 12, [], 'agent');
    expect(agentXml).toMatch(/one-line confirmation of what you understood/i);

    const instantNative = getNativeSystemPrompt(undefined, 8, 4, 'instant');
    expect(instantNative).not.toMatch(/one-line confirmation/);
    const searchNative = getNativeSystemPrompt(undefined, 24, 12, 'search_chat');
    expect(searchNative).not.toMatch(/one-line confirmation/);
  });
});
