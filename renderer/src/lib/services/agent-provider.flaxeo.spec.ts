import { describe, expect, it, vi } from 'vitest';
import {
  getCodeAgentDriverRegistry,
  listCodeAgentProviders,
  normalizeCodeAgentInstanceId,
  resolveCodeAgentInstance
} from '$lib/services/agent-provider';
import { CODE_AGENT_TOOL_NAMES, getToolDefinitions } from '$lib/services/agent-tooling';
import { getFlaxeoCodeSystemPrompt } from '$lib/services/agent-prompts';

describe('Flaxeo Agent (built-in code)', () => {
  it('normalizes aliases to chatea-agent instance', () => {
    expect(normalizeCodeAgentInstanceId('flaxeo-agent')).toBe('chatea-agent');
    expect(normalizeCodeAgentInstanceId('flaxeo')).toBe('chatea-agent');
    expect(normalizeCodeAgentInstanceId('pi')).toBe('chatea-agent');
    expect(normalizeCodeAgentInstanceId('chatea-agent')).toBe('chatea-agent');
  });

  it('exposes Flaxeo Agent as ready default coding provider', () => {
    const providers = listCodeAgentProviders();
    const flaxeo = providers.find((p) => p.id === 'chatea-agent');
    expect(flaxeo).toBeTruthy();
    expect(flaxeo!.label).toBe('Flaxeo Agent');
    expect(flaxeo!.status).toBe('ready');
    expect(flaxeo!.detail.toLowerCase()).toContain('pi');
    expect(providers[0].id).toBe('chatea-agent');
  });

  it('resolves adapter with Flaxeo branding', () => {
    const adapter = resolveCodeAgentInstance('flaxeo-agent');
    expect(adapter.instance.displayName).toBe('Flaxeo Agent');
    expect(adapter.instance.driverKind).toBe('chatea-agent');
  });

  it('registers only runnable adapters and lists every instance once', () => {
    expect(Object.keys(getCodeAgentDriverRegistry()).sort()).toEqual(['agente', 'chatea', 'chatea-agent']);

    const providers = listCodeAgentProviders();
    const ids = providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const retired of ['codex', 'claude', 'cursor', 'opencode', 'pi']) {
      expect(ids).not.toContain(retired);
    }
  });

  it('treats pi as an alias instead of a duplicate registry entry', () => {
    expect(getCodeAgentDriverRegistry().pi).toBeUndefined();
    expect(resolveCodeAgentInstance('pi').instance.id).toBe('chatea-agent');
  });

  it('warns and falls back to the built-in code agent for unknown ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd or retired persisted id must land on the code profile, never
      // silently on the chat-only `chatea` profile.
      for (const unknown of ['typo-instance', 'codex', 'cursor']) {
        const adapter = resolveCodeAgentInstance(unknown);
        expect(adapter.instance.id).toBe('chatea-agent');
        expect(adapter.instance.driverKind).toBe('chatea-agent');
      }
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('typo-instance'));
    } finally {
      warn.mockRestore();
    }
  });

  it('code profile exposes coding + web + diagnostics tools', () => {
    const tools = getToolDefinitions('workspace', {}, 'code');
    const names = tools.map((t) => t.function.name);
    expect(names.length).toBe(CODE_AGENT_TOOL_NAMES.size);
    for (const name of names) {
      expect(CODE_AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(names).toContain('web_search');
    expect(names).toContain('fetch_url');
    expect(names).toContain('get_diagnostics');
    expect(names).not.toContain('create_document');
  });

  it('has a Pi-inspired system prompt', () => {
    const prompt = getFlaxeoCodeSystemPrompt();
    expect(prompt).toContain('Flaxeo Agent');
    expect(prompt.toLowerCase()).toMatch(/edit_file|bash|workspace|diagnostic|web_search/);
  });
});
