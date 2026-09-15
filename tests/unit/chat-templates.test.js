import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectModelFamily,
  detectTemplateThinkingSupport,
  detectTemplateToolSupport,
  inferTemplateFromTokens,
  resolveEffectiveTemplate,
  probeGgufChatTokens,
  sidecarTemplatePath,
  MINICPM5_TEMPLATE,
  GENERIC_CHATML_THINKING_TEMPLATE
} from '../../main/chat-templates.ts';
import { resolveChatTemplateForModel } from '../../main/process-manager.ts';

// The model that exposed the bug: a MiniCPM5 re-quant whose GGUF lost
// `tokenizer.chat_template`, leaving llama-server on a generic shell where
// thinking could not be toggled.
const ABLITERATED_MODEL = '/home/work/.config/Chatea/models/llama-cpp/test/minicpm5-2b-abliterated-uncensored-safetensors-iq3_m-imat.gguf';

describe('chat template capability detection', () => {
  it('finds the real thinking controls', () => {
    assert.equal(detectTemplateThinkingSupport('{%- if enable_thinking is false %}<think>{% endif %}'), true);
    assert.equal(detectTemplateThinkingSupport('{{ reasoning_effort }}'), true);
    assert.equal(detectTemplateThinkingSupport('{% if thinking_budget %}{% endif %}'), true);
    assert.equal(detectTemplateThinkingSupport('<think>plan</think>'), true);
    assert.equal(detectTemplateThinkingSupport(MINICPM5_TEMPLATE), true);
    assert.equal(detectTemplateThinkingSupport(GENERIC_CHATML_THINKING_TEMPLATE), true);
  });

  it('does not fire on prose that merely mentions thinking', () => {
    // The old /thinking/i regex reported support here; the server reports none.
    assert.equal(detectTemplateThinkingSupport('Answer with chain of thought thinking style in your reply.'), false);
    assert.equal(detectTemplateThinkingSupport("{% for message in messages %}{{ message.content }}{% endfor %}"), false);
    assert.equal(detectTemplateThinkingSupport(''), false);
    assert.equal(detectTemplateThinkingSupport(null), false);
  });

  it('detects tool rendering from the tools/tool_call contract', () => {
    assert.equal(detectTemplateToolSupport(MINICPM5_TEMPLATE), true);
    assert.equal(detectTemplateToolSupport('{% if tools %}<tool_call>{% endif %}'), true);
    assert.equal(detectTemplateToolSupport('You are a helpful assistant.'), false);
  });
});

describe('model family detection', () => {
  it('uses the GGUF metadata signals llama.cpp uses', () => {
    assert.equal(detectModelFamily({ tokenizer_pre: 'minicpm5' }), 'minicpm5');
    assert.equal(detectModelFamily({ general_basename: 'MiniCPM5' }), 'minicpm5');
    assert.equal(detectModelFamily({ general_name: 'MiniCPM5 2B Abliterated Uncensored Safetensors' }), 'minicpm5');
    assert.equal(detectModelFamily({ architecture: 'llama' }, '/models/MiniCPM5-1B-Q4.gguf'), 'minicpm5');
    assert.equal(detectModelFamily({ architecture: 'llama', general_basename: 'Llama 3.1 8B' }), null);
  });
});

describe('effective template resolution', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-template-test-'));
  const modelPath = path.join(tempDir, 'UnknownModel-1B-Q4_K_M.gguf');
  fs.writeFileSync(modelPath, 'GGUF-not-really');

  it('prefers a sidecar template', () => {
    const sidecar = sidecarTemplatePath(modelPath);
    fs.writeFileSync(sidecar, '{%- if enable_thinking is false %}<think>{% endif %}sidecar');
    try {
      const resolved = resolveEffectiveTemplate({ modelPath, fields: { architecture: 'llama' } });
      assert.equal(resolved.source, 'sidecar');
      assert.match(resolved.template || '', /sidecar/);
    } finally {
      fs.rmSync(sidecar, { force: true });
    }
  });

  it('prefers the embedded GGUF template when there is no sidecar', () => {
    const resolved = resolveEffectiveTemplate({
      modelPath,
      fields: { architecture: 'llama' },
      ggufTemplate: 'embedded-template'
    });
    assert.equal(resolved.source, 'gguf');
    assert.equal(resolved.template, 'embedded-template');
  });

  it('falls back to the family template for an identifiable model', () => {
    const resolved = resolveEffectiveTemplate({
      modelPath,
      fields: { tokenizer_pre: 'minicpm5' }
    });
    assert.equal(resolved.source, 'builtin');
    assert.equal(resolved.family, 'minicpm5');
    assert.equal(detectTemplateThinkingSupport(resolved.template), true);
  });

  it('infers the generic ChatML+thinking template from vocabulary tokens', () => {
    const resolved = resolveEffectiveTemplate({
      modelPath,
      fields: { architecture: 'llama' },
      tokens: { hasImStart: true, hasThink: true, hasToolCall: true }
    });
    assert.equal(resolved.source, 'builtin');
    assert.equal(resolved.family, 'generic-chatml-thinking');
    assert.equal(detectTemplateThinkingSupport(resolved.template), true);
    assert.equal(detectTemplateToolSupport(resolved.template), true);
  });

  it('returns none when nothing identifies the model', () => {
    const resolved = resolveEffectiveTemplate({
      modelPath,
      fields: { architecture: 'llama' },
      tokens: { hasImStart: false, hasThink: false, hasToolCall: false }
    });
    assert.equal(resolved.source, 'none');
    assert.equal(resolved.template, null);
  });
});

describe('generic token inference', () => {
  it('accepts ChatML vocabularies that own the thinking token', () => {
    const inferred = inferTemplateFromTokens({ hasImStart: true, hasThink: true, hasToolCall: true, architecture: 'llama' });
    assert.equal(inferred && inferred.family, 'generic-chatml-thinking');
    const qwen = inferTemplateFromTokens({ hasImStart: true, hasThink: true, hasToolCall: false, architecture: 'qwen3' });
    assert.equal(qwen && qwen.family, 'generic-chatml-thinking');
  });

  it('refuses vocabularies without a thinking token to toggle', () => {
    assert.equal(inferTemplateFromTokens({ hasImStart: true, hasThink: false, hasToolCall: true, architecture: 'llama' }), null);
    assert.equal(inferTemplateFromTokens({ hasImStart: false, hasThink: true, hasToolCall: true, architecture: 'llama' }), null);
  });
});

describe('server argument resolution', () => {
  it('materializes a template file for a template-less known family', () => {
    if (!fs.existsSync(ABLITERATED_MODEL)) return; // fixture model not present
    const resolved = resolveChatTemplateForModel(ABLITERATED_MODEL, true);
    assert.equal(resolved.source, 'builtin');
    assert.equal(resolved.family, 'minicpm5');
    assert.ok(resolved.templateFile && fs.existsSync(resolved.templateFile));
    const written = fs.readFileSync(resolved.templateFile, 'utf8');
    assert.ok(written.includes('enable_thinking'));
  });

  it('prefers a downloaded sidecar over the family fallback', () => {
    if (!fs.existsSync(ABLITERATED_MODEL)) return;
    const sidecar = sidecarTemplatePath(ABLITERATED_MODEL);
    const previous = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8') : null;
    try {
      // What a completed download writes: the hub's own template wins over
      // the family fallback and lands in the server args unchanged.
      const fromHub = '{%- if tools %}hub-template{% endif %}{%- if enable_thinking is false %}<think>{% endif %}';
      fs.writeFileSync(sidecar, fromHub);
      const resolved = resolveChatTemplateForModel(ABLITERATED_MODEL, true);
      assert.equal(resolved.source, 'sidecar');
      assert.ok(resolved.templateFile && fs.existsSync(resolved.templateFile));
      assert.equal(fs.readFileSync(resolved.templateFile, 'utf8'), fromHub);
    } finally {
      if (previous === null) fs.rmSync(sidecar, { force: true });
      else fs.writeFileSync(sidecar, previous);
    }
  });

  it('leaves embedded templates on the GGUF (no extra file)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-template-embedded-'));
    const modelPath = path.join(dir, 'MiniCPM5-1B.gguf');
    fs.writeFileSync(modelPath, 'GGUF');
    // resolveEffectiveTemplate reads the raw template from fields here; the
    // arg builder must not write a file when the GGUF carries its own.
    const resolved = resolveEffectiveTemplate({
      modelPath,
      fields: { tokenizer_pre: 'minicpm5' },
      ggufTemplate: 'embedded'
    });
    assert.equal(resolved.source, 'gguf');
  });
});

describe('GGUF vocabulary probe', () => {
  it('reports the chat tokens the MiniCPM5 header declares', () => {
    if (!fs.existsSync(ABLITERATED_MODEL)) return;
    const tokens = probeGgufChatTokens(ABLITERATED_MODEL);
    assert.equal(tokens.hasImStart, true);
    assert.equal(tokens.hasThink, true);
    assert.equal(tokens.hasToolCall, true);
  });

  it('returns empty flags for an unreadable file instead of throwing', () => {
    assert.deepEqual(probeGgufChatTokens('/nonexistent/model.gguf'), {
      hasImStart: false,
      hasThink: false,
      hasToolCall: false
    });
  });
});
