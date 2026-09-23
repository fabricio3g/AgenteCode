import { describe, expect, it } from 'vitest';
import { extractToolCalls, normalizeMapCalls, websiteWritesFromCodeblocks } from './agent-tool-calls';

const base = { iter: 0, nativeInUse: false, wantsWebsiteArtifact: false };

describe('extractToolCalls', () => {
  it('native calls keep their ids and echo reasoning and provider state', () => {
    const extracted = extractToolCalls({
      ...base,
      nativeInUse: true,
      rawContent: 'Checking.',
      completion: { toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '2+2' } }], reasoning: 'think', providerState: { provider: 'gemini', blocks: [] } }
    });
    expect(extracted.textDialect).toBe(false);
    expect(extracted.toolCalls).toEqual([{ id: 'c1', name: 'calculator', arguments: { expression: '2+2' } }]);
    expect(extracted.assistantMessage).toMatchObject({ reasoning_content: 'think', providerState: { provider: 'gemini', blocks: [] } });
    expect(extracted.assistantMessage?.tool_calls?.[0]).toMatchObject({ id: 'c1', function: { name: 'calculator' } });
  });

  it('parses the XML contract and marks the run as text-dialect', () => {
    const extracted = extractToolCalls({
      ...base,
      rawContent: 'Let me check. <tool_call>{"name":"web_search","arguments":{"query":"x"}}</tool_call>',
      completion: {}
    });
    expect(extracted.textDialect).toBe(true);
    expect(extracted.toolCalls[0]).toMatchObject({ name: 'web_search', arguments: { query: 'x' } });
    expect(String(extracted.assistantMessage?.content)).not.toContain('tool_call');
  });

  it('plain prose yields nothing to run', () => {
    const extracted = extractToolCalls({ ...base, rawContent: 'Paris is the capital.', completion: {} });
    expect(extracted).toEqual({ toolCalls: [], cleanContent: 'Paris is the capital.', assistantMessage: null, textDialect: false });
  });

  it('website code blocks become writes only for website builds', () => {
    const raw = '```html\n<!doctype html><html><body>Hi</body></html>\n```';
    expect(extractToolCalls({ ...base, rawContent: raw, completion: {} }).toolCalls).toHaveLength(0);
    const site = extractToolCalls({ ...base, wantsWebsiteArtifact: true, rawContent: raw, completion: {} });
    expect(site.toolCalls.map((tc) => tc.name)).toEqual(['write_file', 'preview_project']);
  });
});

describe('websiteWritesFromCodeblocks', () => {
  it('previews only when there is an HTML entry', () => {
    const css = websiteWritesFromCodeblocks('```css\nbody { color: red; }\n```');
    expect(css?.toolCalls.map((tc) => tc.name)).toEqual(['write_file']);
    expect(websiteWritesFromCodeblocks('no code here')).toBeNull();
  });
});

describe('normalizeMapCalls', () => {
  it('maps the text-dialect `maps` alias onto create_map with a place', () => {
    const [call] = normalizeMapCalls([{ id: 'm', name: 'maps', arguments: { center: 'Lima, Peru', zoom: 11 } }], false);
    expect(call).toEqual({ id: 'm', name: 'create_map', arguments: { place: 'Lima, Peru', zoom: 11 } });
  });

  it('leaves a native `maps` call alone', () => {
    const calls = [{ id: 'm', name: 'maps', arguments: { center: 'Lima' } }];
    expect(normalizeMapCalls(calls, true)).toEqual(calls);
  });
});
