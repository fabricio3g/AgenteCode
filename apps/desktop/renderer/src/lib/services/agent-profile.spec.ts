import { describe, expect, it } from 'vitest';
import { CHAT_AGENT_TOOL_NAMES, CODE_AGENT_TOOL_NAMES, getToolDefinitions } from '$lib/services/agent-tooling';
import { getAgenteChatSystemPrompt, getNativeSystemPrompt } from '$lib/services/agent-prompts';

describe('agent profiles', () => {
  it('chat profile excludes host shell and diagnostics', () => {
    const names = getToolDefinitions('sandbox', {}, 'chat').map((t) => t.function.name);
    expect(names).toContain('web_search');
    expect(names).toContain('fetch_url');
    expect(names).toContain('calculator');
    for (const tool of ['browser_open', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_press', 'browser_wait', 'browser_console', 'browser_screenshot', 'browser_hover', 'browser_select', 'browser_forward', 'browser_reload', 'browser_read', 'browser_tabs']) {
      expect(names).toContain(tool);
    }
    // Replaced by ref-based tools (the dispatcher still accepts the old names).
    expect(names).not.toContain('browser_navigate');
    expect(names).not.toContain('browser_type');
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
    expect(getAgenteChatSystemPrompt()).toContain('You are Agente');
    expect(getAgenteChatSystemPrompt().toLowerCase()).toContain('shell');
    // The code profile's own framing lives in the base prompt now; the
    // standalone code prompt was a second copy that shipped twice.
    expect(getNativeSystemPrompt(undefined, 80, 28, 'agent', 'workspace')).toContain(
      'You are Agente, a coding agent'
    );
  });
});
