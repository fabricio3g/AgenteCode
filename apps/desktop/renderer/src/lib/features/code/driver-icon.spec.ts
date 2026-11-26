// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { resolveDriverIcon } from './driver-icon';

const BUILTINS = [
  'agente',
  'claude',
  'codex',
  'opencode',
  'pi',
  'copilot',
  'gemini',
  'qwen',
  'cursor',
  'goose',
  'cline',
  'kilo',
  'kimi',
  'auggie',
  'kiro',
  'droid',
  'vibe',
  'amp',
  'grok',
  'junie',
  'devin',
  'qoder'
] as const;

it('maps Agente Core and every built-in CLI to its dedicated icon key', () => {
  for (const id of BUILTINS) {
    expect(resolveDriverIcon(id, id === 'agente' ? 'agente' : 'acp')).toBe(id);
  }
});

it('inherits the parent brand icon for custom extends profiles', () => {
  expect(resolveDriverIcon('claude-work', 'claude')).toBe('claude');
  expect(resolveDriverIcon('codex_team', 'codex')).toBe('codex');
  expect(resolveDriverIcon('codex-acp', 'acp')).toBe('codex');
  expect(resolveDriverIcon('opencode-local', 'opencode')).toBe('opencode');
  expect(resolveDriverIcon('copilot-enterprise', 'acp')).toBe('copilot');
  expect(resolveDriverIcon('droid-staging', 'acp')).toBe('droid');
  expect(resolveDriverIcon('qwen-prod', 'acp')).toBe('qwen');
});

it('falls back to driverKind when the instance id is custom, and generic for custom ACP', () => {
  expect(resolveDriverIcon('my-custom-profile', 'claude')).toBe('claude');
  expect(resolveDriverIcon('team-agent', 'codex')).toBe('codex');
  expect(resolveDriverIcon('internal-acp-tool', 'acp')).toBe('generic');
  expect(resolveDriverIcon(undefined, undefined)).toBe('generic');
});
