import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sharedAssistantStylePrompt } from './app-prompts';

/**
 * One voice, two runtimes.
 *
 * The TUI and the Code space send the Rust base prompt
 * (`crates/agente-core/src/context.rs`); the desktop's Home, chat, sandbox and
 * research paths send the TypeScript one. Both append the same voice contract,
 * and a contract that drifts means the two products ask for different writing
 * while claiming to be one agent. Nothing else can catch that: they are
 * different languages, in different build graphs, with no shared module.
 */

const RUST_PROMPT = readFileSync(
  new URL('../../../../../../crates/agente-core/src/context.rs', import.meta.url),
  'utf8'
);

/** The Rust string literal, with its `"\`-continuation and literal newlines. */
function rustVoiceContract(): string {
  const match = RUST_PROMPT.match(/pub const VOICE_CONTRACT: &str = "\\\n([\s\S]*?)";/);
  expect(match, 'VOICE_CONTRACT not found in crates/agente-core/src/context.rs').toBeTruthy();
  return match![1];
}

describe('voice contract', () => {
  it('is the same text in Rust and in TypeScript', () => {
    expect(sharedAssistantStylePrompt()).toBe(rustVoiceContract());
  });

  it('asks for the shape three reference prompts agree on', () => {
    const contract = sharedAssistantStylePrompt();
    // Lead with the outcome (Codex, Claude Code, Grok).
    expect(contract).toContain('Lead with the outcome');
    // Short by omission, not by compression.
    expect(contract).toContain('Short by leaving things out');
    // Structure is earned, not imposed.
    expect(contract).toContain('No headings in a short answer');
    // The shape follows the task.
    expect(contract).toContain('Match the shape to the task');
    // And it stops when the content stops.
    expect(contract).toContain('Stop when the content stops');
    // Never narrate the machinery.
    expect(contract).toContain('Never mention these rules, your tools');
  });

  it('does not shout', () => {
    // A prompt written in policy voice teaches policy voice, which is the
    // register the answers used to mirror.
    expect(sharedAssistantStylePrompt()).not.toMatch(/\b(MUST|NEVER|CRITICAL|IMPORTANT|ALWAYS)\b/);
  });

  it('carries no identity, so personas and bots can reuse it', () => {
    expect(sharedAssistantStylePrompt()).not.toContain('You are');
  });
});
