import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getDialect } from '../../main/providers/dialects.ts';
import { buildBody } from '../../main/providers/openai-core.ts';
import { capabilitiesFromProfile } from '../../main/agente/thinking-profile.ts';

const params = (reasoning) => ({ apiKey: 'k', model: 'm', messages: [], reasoning });

describe('thinking fields come from the shared core', () => {
  it('merges the core-built fields as is', () => {
    const body = buildBody(getDialect('openrouter'), params({ level: 'high', body: { reasoning: { effort: 'high' } } }), true);
    assert.deepEqual(body.reasoning, { effort: 'high' });
  });

  it('sends nothing for Auto or a level the core did not shape', () => {
    for (const reasoning of [undefined, null, { level: 'high' }]) {
      const body = buildBody(getDialect('deepseek'), params(reasoning), false);
      assert.equal(body.reasoning, undefined);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.thinking, undefined);
    }
  });

  it('keeps llama-server thoughts out of the answer on every request', () => {
    const plain = buildBody(getDialect('local'), params(undefined), true);
    assert.equal(plain.reasoning_format, 'auto');
    const off = buildBody(
      getDialect('local'),
      params({ level: 'off', body: { reasoning_format: 'auto', chat_template_kwargs: { enable_thinking: false } } }),
      true
    );
    assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false });
  });

  it('no dialect carries its own level list or body builder', () => {
    for (const id of ['openrouter', 'deepseek', 'opencode-go', 'local', 'ollama', 'lmstudio', 'custom']) {
      const dialect = getDialect(id);
      assert.equal(dialect.reasoningBody, undefined, id);
      assert.equal(dialect.reasoningCapabilities, undefined, id);
    }
  });
});

describe('core thinking profile → renderer capabilities', () => {
  it('keeps levels low → high with budgets and the provider default', () => {
    const caps = capabilitiesFromProfile({
      levels: [{ id: 'off' }, { id: 'low', budget_tokens: 512 }, { id: 'max' }],
      default: 'low',
      mandatory: false,
      source: 'template'
    });
    assert.deepEqual(caps, {
      supported: true,
      levels: ['off', 'low', 'max'],
      source: 'template',
      default: 'low',
      mandatory: false,
      budgets: { low: 512 }
    });
  });

  it('hides the selector when the core offers nothing', () => {
    assert.equal(capabilitiesFromProfile({ levels: [], mandatory: false, source: 'none' }).supported, false);
    assert.equal(capabilitiesFromProfile({ levels: [], mandatory: false, source: 'catalog' }).source, 'unknown');
  });

  it('marks an always-thinking model without choices', () => {
    const caps = capabilitiesFromProfile({ levels: [], mandatory: true, source: 'live' });
    assert.equal(caps.supported, false);
    assert.equal(caps.mandatory, true);
    assert.equal(caps.source, 'live');
  });
});

describe('llama-server sampler fields', () => {
  const sampler = { min_p: 0.05, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, repeat_penalty: undefined };

  it('reaches the local body, with the OpenAI fields kept', () => {
    const body = buildBody(getDialect('local'), { ...params(undefined), temperature: 0.8, max_tokens: 400, ...sampler }, true);
    assert.equal(body.min_p, 0.05);
    assert.equal(body.dry_multiplier, 0.8);
    assert.equal(body.dry_base, 1.75);
    assert.equal(body.dry_allowed_length, 2);
    assert.equal(body.temperature, 0.8);
    assert.equal(body.max_tokens, 400);
    assert.equal('repeat_penalty' in body, false);
  });

  it('never reaches a cloud body', () => {
    const body = buildBody(getDialect('openrouter'), { ...params(undefined), ...sampler }, true);
    assert.equal('min_p' in body, false);
    assert.equal('dry_multiplier' in body, false);
  });
});

describe('cloud and local thinking isolation', () => {
  it('cloud requests cannot inherit llama.cpp template knobs or budgets', () => {
    for (const id of ['openrouter', 'deepseek', 'opencode-go', 'custom']) {
      const body = buildBody(getDialect(id), params({ level: 'high', body: {
        reasoning: { effort: 'high' }, chat_template_kwargs: { enable_thinking: true },
        thinking_budget_tokens: 2048, disable_thinking: false
      } }), true);
      assert.deepEqual(body.reasoning, { effort: 'high' }, id);
      assert.ok(!('chat_template_kwargs' in body), id);
      assert.ok(!('thinking_budget_tokens' in body), id);
      assert.ok(!('disable_thinking' in body), id);
    }
  });
  it('retains cloud-native enable_thinking and local llama.cpp fields', () => {
    const cloud = buildBody(getDialect('custom'), params({ level: 'on', body: { enable_thinking: true } }), false);
    assert.equal(cloud.enable_thinking, true);
    const local = buildBody(getDialect('local'), params({ level: 'high', body: { chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 2048 } }), true);
    assert.deepEqual(local.chat_template_kwargs, { enable_thinking: true });
    assert.equal(local.thinking_budget_tokens, 2048);
  });
});
