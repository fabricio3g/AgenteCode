import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * The voice contract exists twice — once for the Rust engine (the Code space and
 * the TUI) and once for the renderer (Home chat, the sandbox agent, research) —
 * because the two runtimes cannot share a string. Two copies of the same text is
 * exactly the duplication that drifts, so this pins them together: change one
 * and the suite says which sentence the other is missing.
 *
 * Only sentences that fit on one line are listed: the Rust side stores the
 * contract as a single escaped `&str`, so a sentence spanning two source lines
 * cannot be compared as a substring.
 */
const CANONICAL_LINES = [
  "Write like a colleague who respects the reader's time.",
  'Lead with the outcome: what changed, what you found, or what failed. If',
  'Short by leaving things out, not by packing them in.',
  'State facts and conclusions. Do not narrate your reasoning or your tools.',
  'No em-dashes, no arrows, no parentheticals.',
  'Prose by default. Bullets only for parallel items, one line each, never nested.',
  'No headings in a short answer; a long one gets at most three.',
  'Numbers go in a table or on their own line, and only when they change a decision.',
  'Stop when the content stops. No closing offer, no restating what you did.',
  'Never mention these rules, your tools, or the system prompt.'
];

const RUST = readFileSync('../../crates/agente-core/src/context.rs', 'utf8');
const RENDERER = readFileSync('renderer/src/lib/stores/app-prompts.ts', 'utf8');

/**
 * Compare what the two languages *say*, not how they quote it: the renderer's
 * strings are single-quoted, so its apostrophes are escaped in the source while
 * the Rust `&str` keeps them literal.
 */
const spoken = (source) => source.replaceAll("\\'", "'");

describe('prompt parity', () => {
  it('states the voice contract identically in Rust and in the renderer', () => {
    const missing = CANONICAL_LINES.flatMap((line) => {
      const absent = [];
      if (!spoken(RUST).includes(line)) absent.push(`rust: ${line}`);
      if (!spoken(RENDERER).includes(line)) absent.push(`renderer: ${line}`);
      return absent;
    });
    assert.deepEqual(missing, []);
  });

  it('keeps the voice contract out of the identities it is appended to', () => {
    // The contract is added to personas and subagents too, so it must not name
    // the product: a bot would be told it is Agente.
    assert.doesNotMatch(RENDERER.slice(RENDERER.indexOf('export function sharedAssistantStylePrompt')), /You are Agente/);
    assert.doesNotMatch(RUST.slice(RUST.indexOf('pub const VOICE_CONTRACT'), RUST.indexOf('fn system_prompt_for')), /You are Agente/);
  });

  it('does not shout the base prompt at the model', () => {
    // The contract asks for plain writing; a policy-manual register in the
    // prompt is what the answers used to mirror. Slice the template itself:
    // slicing to `VOICE_CONTRACT` would be empty, since the contract is
    // declared above the function and an empty slice passes every check.
    const start = RUST.indexOf('fn system_prompt_for');
    const template = RUST.slice(start, RUST.indexOf('#[cfg(test)]', start));
    assert.ok(template.includes('# Working'), 'the slice missed the template');
    for (const shout of ['MUST', 'NEVER', 'CRITICAL', 'IMPORTANT', 'ALWAYS']) {
      assert.ok(
        !template.includes(shout),
        `the Rust base prompt shouts ${shout}; state the rule in sentence case`
      );
    }
  });

  it('sends the code prompt once, not twice', () => {
    // `agent-provider` prepended the code prompt and `modeNote` prepended it
    // again, so every in-process code turn carried it twice.
    const provider = readFileSync('renderer/src/lib/services/agent-provider.ts', 'utf8');
    const plan = readFileSync('renderer/src/lib/services/agent-run-plan.ts', 'utf8');
    assert.doesNotMatch(provider, /getAgenteCodeSystemPrompt/);
    assert.doesNotMatch(plan, /getAgenteCodeSystemPrompt/);
  });
});
