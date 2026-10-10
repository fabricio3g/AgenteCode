import { describe, expect, it } from 'vitest';
import { LOCAL_ROLEPLAY_MAX_TOKENS, localRoleplaySampling } from '$lib/services/roleplay-prompts';
import { buildReasoningRequest } from '$lib/services/chat-api';

/** The sampler fields a local roleplay turn sends: what llama-server reads from the body. */
describe('local roleplay sampler payload', () => {
  const preset = { localSampler: 'roleplay', repetition: 'dry' } as const;

  it('applies the roleplay preset where the scene is unset', () => {
    const tuned = localRoleplaySampling({}, preset, 8192);
    expect(tuned.sampling).toEqual({ temperature: 0.8, topP: 1, maxTokens: LOCAL_ROLEPLAY_MAX_TOKENS });
    expect(tuned.extra).toEqual({ min_p: 0.05, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2 });
  });

  it('uses a plain repeat penalty when the scene asks for it, with no DRY fields', () => {
    const tuned = localRoleplaySampling({}, { localSampler: 'roleplay', repetition: 'repeat' }, 8192);
    expect(tuned.extra).toEqual({ min_p: 0.05, repeat_penalty: 1.05 });
  });

  it('keeps the scene value over the preset', () => {
    const tuned = localRoleplaySampling({ temperature: 1.1, topP: 0.9, maxTokens: 200 }, preset, 8192);
    expect(tuned.sampling).toEqual({ temperature: 1.1, topP: 0.9, maxTokens: 200 });
  });

  it('never asks for more than a quarter of the window, however the scene is set', () => {
    expect(localRoleplaySampling({}, preset, 1024).sampling.maxTokens).toBe(256);
    expect(localRoleplaySampling({ maxTokens: 4000 }, preset, 2048).sampling.maxTokens).toBe(512);
  });

  it("leaves llama-server's own defaults alone under the server setting", () => {
    const tuned = localRoleplaySampling({}, { localSampler: 'server', repetition: 'dry' }, 4096);
    expect(tuned.extra).toEqual({});
    expect(tuned.sampling.temperature).toBeUndefined();
    expect(tuned.sampling.maxTokens).toBe(LOCAL_ROLEPLAY_MAX_TOKENS);
  });
});

/** The thinking flag: Settings toggle, the chat's level, then the backend default. */
describe('roleplay thinking level on the wire', () => {
  it('sends an explicit off for local roleplay by default, which the core maps to enable_thinking false', () => {
    expect(buildReasoningRequest('off')).toEqual({ level: 'off' });
  });

  it('sends nothing for a cloud roleplay with no choice, so the provider decides', () => {
    expect(buildReasoningRequest(null)).toBeUndefined();
  });
});
