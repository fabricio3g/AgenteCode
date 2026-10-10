import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { sharedAssistantStylePrompt } from '../../renderer/src/lib/stores/app-prompts.ts';

const RUST = readFileSync('../../crates/agente-core/src/context.rs', 'utf8');
const RENDERER = readFileSync('renderer/src/lib/stores/app-prompts.ts', 'utf8');

describe('prompt parity', () => {
  it('states the voice contract identically in Rust and in the renderer', () => {
    const match = RUST.match(/pub const VOICE_CONTRACT: &str = "\\\n([\s\S]*?)";/);
    assert.ok(match, 'Rust voice contract must exist');
    assert.equal(sharedAssistantStylePrompt(), match[1]);
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
    // The production run plan owns the code prompt; there is no adapter prefix.
    const plan = readFileSync('renderer/src/lib/services/agent-run-plan.ts', 'utf8');
    assert.match(plan, /native: getNativeSystemPrompt\(/);
    assert.doesNotMatch(plan, /getAgenteCodeSystemPrompt/);
  });
});
