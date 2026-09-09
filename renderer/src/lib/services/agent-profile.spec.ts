import { describe, expect, it } from 'vitest';
import { CHAT_AGENT_TOOL_NAMES, CODE_AGENT_TOOL_NAMES, getToolDefinitions } from '$lib/services/agent-tooling';
import { getFlaxeoChatSystemPrompt, getFlaxeoCodeSystemPrompt } from '$lib/services/agent-prompts';

describe('agent profiles', () => {
  it('chat profile excludes host shell and diagnostics', () => {
    const names = getToolDefinitions('sandbox', {}, 'chat').map((t) => t.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('fetch_url');
    expect(names).toContain('calculator');
    expect(names).toContain('browser_open');
    expect(names).toContain('browser_navigate');
    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_type');
    expect(names).toContain('browser_screenshot');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('get_diagnostics');
    expect(names).not.toContain('edit_file');
    for (const n of names) expect(CHAT_AGENT_TOOL_NAMES.has(n)).toBe(true);
  });

  it('code profile keeps coding + web tools', () => {
    const names = getToolDefinitions('workspace', {}, 'code').map((t) => t.function.name);
    expect(names).toContain('bash');
    expect(names).toContain('edit_file');
    expect(names).toContain('web_search');
    expect(names).toContain('get_diagnostics');
    expect(names.length).toBe(CODE_AGENT_TOOL_NAMES.size);
  });

  it('work profile is full surface', () => {
    const names = getToolDefinitions('sandbox', {}, 'work').map((t) => t.function.name);
    expect(names.length).toBeGreaterThan(CHAT_AGENT_TOOL_NAMES.size);
    expect(names).toContain('web_search');
  });

  it('prompts are profile-specific', () => {
    expect(getFlaxeoChatSystemPrompt()).toContain('Chat Agent');
    expect(getFlaxeoChatSystemPrompt().toLowerCase()).toContain('shell');
    expect(getFlaxeoCodeSystemPrompt()).toContain('Flaxeo Agent');
  });
});
