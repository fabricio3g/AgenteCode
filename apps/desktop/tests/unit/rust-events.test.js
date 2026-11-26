import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RustTurnTranslator } from '../../main/agente/rust-events.ts';

function wrap(event) {
  return {
    protocol_version: 2,
    session_id: '00000000-0000-0000-0000-000000000001',
    turn_id: 'turn-1',
    sequence: 1,
    timestamp: '2026-11-25T00:00:00Z',
    parent_run_id: null,
    event
  };
}

describe('RustTurnTranslator external driver extensions', () => {
  it('forwards native ApprovalOption choices on approval_requested', () => {
    const translator = new RustTurnTranslator('chat-1', () => 32_768);
    const options = [
      { id: 'deny', kind: 'deny', label: 'Deny' },
      { id: 'always', kind: 'approve_all', label: 'Always Allow' },
      { id: 'once', kind: 'approve_once', label: 'Allow Once' }
    ];

    const out = translator.translate(wrap({
      type: 'approval_requested',
      request_id: 'req-1',
      source: 'driver',
      tool_name: 'shell',
      tool_args: '{"command":"npm test"}',
      description: 'Run tests',
      is_dangerous: false,
      options
    }));

    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'approval_request');
    assert.deepEqual(out[0].options, options);
  });

  it('translates mode_changed, model_changed, and usage_limit_reached events', () => {
    const translator = new RustTurnTranslator('chat-2', () => 32_768);

    const modeEvents = translator.translate(wrap({ type: 'mode_changed', mode: 'plan' }));
    assert.deepEqual(modeEvents, [{ type: 'mode_changed', chatId: 'chat-2', mode: 'plan' }]);

    const modelEvents = translator.translate(wrap({ type: 'model_changed', model: 'sonnet', provider: 'claude' }));
    assert.deepEqual(modelEvents, [{ type: 'model_changed', chatId: 'chat-2', model: 'sonnet', provider: 'claude' }]);

    const limitEvents = translator.translate(wrap({
      type: 'usage_limit_reached',
      message: 'Quota exhausted',
      reset_at: '2026-11-26T00:00:00Z'
    }));
    assert.deepEqual(limitEvents, [{
      type: 'usage_limit_reached',
      chatId: 'chat-2',
      message: 'Quota exhausted',
      resetAt: '2026-11-26T00:00:00Z'
    }]);
  });

  it('translates input_requested and preserves streamed output across repeated tool_proposed updates', () => {
    const translator = new RustTurnTranslator('chat-3', () => 32_768);

    assert.equal(
      translator.translate(wrap({ type: 'tool_proposed', id: 'tc-q', name: 'question', arguments: '{}' }))[0].type,
      'tool_start'
    );
    const progress = translator.translate(wrap({ type: 'tool_progress', id: 'tc-q', chunk: 'partial-out' }));
    assert.equal(progress[0].partialResult, 'partial-out');

    // Second tool_proposed with populated rawInput from tool_call_update
    const enriched = translator.translate(wrap({
      type: 'tool_proposed',
      id: 'tc-q',
      name: 'question',
      arguments: '{"questions":[{"header":"Topic"}]}'
    }));
    assert.equal(enriched[0].type, 'tool_start');
    assert.deepEqual(enriched[0].args, { questions: [{ header: 'Topic' }] });

    const nextProgress = translator.translate(wrap({ type: 'tool_progress', id: 'tc-q', chunk: '+more' }));
    assert.equal(nextProgress[0].partialResult, 'partial-out+more');

    const inputEvents = translator.translate(wrap({
      type: 'input_requested',
      request_id: 'inp-1',
      message: 'Questions',
      tool_call_id: 'tc-q',
      schema: { type: 'object', properties: { q0: { type: 'string', title: 'Topic' } } }
    }));
    assert.deepEqual(inputEvents, [{
      type: 'input_request',
      chatId: 'chat-3',
      requestId: 'inp-1',
      message: 'Questions',
      toolCallId: 'tc-q',
      schema: { type: 'object', properties: { q0: { type: 'string', title: 'Topic' } } }
    }]);
  });
});
