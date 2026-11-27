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

it('gives every built-in CLI a letter mark, told apart by hue when initials match', async () => {
  const { driverMark } = await import('./driver-icon');
  const marks = BUILTINS.filter((id) => id !== 'agente').map((id) => driverMark(id));
  for (const mark of marks) expect(mark.letter).toMatch(/^[A-Z]$/);
  const cs = ['claude', 'codex', 'copilot', 'cursor', 'cline'].map((id) => driverMark(id as (typeof BUILTINS)[number]).hue);
  expect(new Set(cs).size).toBe(cs.length);
});

it('names an unknown CLI by its own initial', async () => {
  const { driverMark } = await import('./driver-icon');
  expect(driverMark('generic', 'zed agent').letter).toBe('Z');
  expect(driverMark('generic', '').letter).toBe('›');
});

it('draws a CLI with its own shipped logo and falls back to a letter mark', async () => {
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { driverLogo } = await import('./driver-icon');
  expect(driverLogo('agente')).toBeNull();
  expect(driverLogo('generic')).toBeNull();
  expect(driverLogo('pi')).toBeNull();
  for (const id of BUILTINS) {
    const logo = driverLogo(id);
    if (logo) expect(existsSync(resolve(__dirname, '../../../../public', logo))).toBe(true);
  }
  expect(driverLogo('claude')).toBe('./drivers/claude.svg');
});
