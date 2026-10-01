import test from 'node:test';
import assert from 'node:assert/strict';
import { RustTurnTranslator, approvalDiff, diffStats, uiToolName } from '../../main/agente/rust-events.ts';

const session = '11111111-1111-4111-8111-111111111111';
let sequence = 0;
function envelope(event, extra = {}) {
  sequence += 1;
  return { protocol_version: 2, sequence, session_id: session, turn_id: 'turn', timestamp: '2026-09-27T00:00:00Z', event, ...extra };
}

function run(translator, events) {
  return events.flatMap((event) => translator.translate(envelope(event)));
}

test('a turn with a command and an edit becomes the Code UI stream', () => {
  const translator = new RustTurnTranslator('chat-1', () => 64_000);
  const out = run(translator, [
    { type: 'turn_started' },
    { type: 'reasoning_delta', text: 'hmm' },
    { type: 'assistant_delta', text: 'Fixing it.' },
    { type: 'tool_proposed', id: 't1', name: 'shell', arguments: '{"command":"npm test"}' },
    { type: 'tool_progress', id: 't1', chunk: 'ok ' },
    { type: 'tool_progress', id: 't1', chunk: '1/1' },
    { type: 'tool_result', id: 't1', name: 'shell', content: 'ok 1/1', is_error: false },
    { type: 'tool_proposed', id: 't2', name: 'edit_file', arguments: '{"path":"a.ts"}' },
    { type: 'tool_result', id: 't2', name: 'edit_file', content: 'edited', is_error: false },
    { type: 'file_changed', path: 'a.ts', summary: 'edited a.ts', before: 'a\nb\n', after: 'a\nc\nd\n' },
    { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 900, cache_creation_tokens: 0, context_tokens: 1000 } },
    { type: 'turn_finished', revision: 2 }
  ]);
  const types = out.map((event) => event.type);
  assert.deepEqual(types, [
    'agent_start', 'turn_start', 'thinking_delta', 'text_delta',
    'tool_start', 'tool_update', 'tool_update', 'tool_end',
    'tool_start', 'tool_end', 'usage',
    'checkpoint_finalized', 'turn_end', 'agent_end'
  ]);
  const [commandStart, edit] = [out.find((e) => e.toolCallId === 't1' && e.type === 'tool_start'), out.find((e) => e.toolCallId === 't2' && e.type === 'tool_end')];
  assert.equal(commandStart.toolName, 'bash', 'shell renders as a command');
  assert.deepEqual(commandStart.args, { command: 'npm test' });
  assert.equal(out.filter((e) => e.type === 'tool_update').at(-1).partialResult, 'ok 1/1', 'output accumulates');
  assert.deepEqual(edit.fileChanges, [{ path: 'a.ts', kind: 'modified' }], 'the edit carries its file change');
  assert.deepEqual(edit.diffStats, [{ path: 'a.ts', kind: 'modified', additions: 2, deletions: 1, patch: '--- a.ts\n+++ a.ts\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d' }]);
  const usage = out.find((e) => e.type === 'usage');
  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.contextWindow, 64_000);
  const checkpoint = out.find((e) => e.type === 'checkpoint_finalized');
  assert.equal(checkpoint.turnIndex, 1);
  assert.equal(out.at(-1).stopReason, 'stop');
});

test('child output, spend and consumed steering survive the desktop translation', () => {
  const translator = new RustTurnTranslator('chat-1', () => 32_000);
  const child = { type: 'child_delta', run_id: 'child-1', text: 'Checked it.' };
  assert.deepEqual(translator.translate(envelope(child)), [{ type: 'runtime_event', chatId: 'chat-1', event: child }]);
  const usage = { type: 'call_usage', cost_usd: 0.02, cost_estimated: false, usage: { prompt_tokens: 100, completion_tokens: 10, cache_read_tokens: 900, cache_creation_tokens: 0 } };
  assert.deepEqual(translator.translate(envelope(usage, { parent_run_id: 'child-1' })), [{ type: 'runtime_event', chatId: 'chat-1', event: usage, parentRunId: 'child-1' }]);
  const injected = { type: 'user_messages_injected', messages: ['Do this first.'] };
  assert.deepEqual(translator.translate(envelope(injected)), [{ type: 'runtime_event', chatId: 'chat-1', event: injected }]);
});

test('approvals, failures and subagent events', () => {
  const translator = new RustTurnTranslator('chat-2', () => 0);
  const [approval] = run(translator, [{
    type: 'approval_requested', request_id: 'r1', source: 'parent', tool_name: 'write_file',
    tool_args: '{"path":"x.txt"}', description: 'write x', is_dangerous: false,
    file_path: 'x.txt', old_content: null, new_content: 'hi'
  }]);
  assert.equal(approval.type, 'approval_request');
  assert.equal(approval.toolName, 'write');
  assert.equal(approval.diff, '--- x.txt\n+++ x.txt\n@@ -1,0 +1,1 @@\n+hi');

  // A subagent's own events never become this chat's steps.
  const child = translator.translate(envelope({ type: 'assistant_delta', text: 'child' }, { parent_run_id: 'run-1' }));
  assert.equal(child[0].type, 'runtime_event');
  assert.equal(child[0].parentRunId, 'run-1');

  const failed = run(translator, [{ type: 'turn_started' }, { type: 'turn_failed', message: 'provider down' }]);
  assert.deepEqual(failed.map((e) => e.type), ['agent_start', 'turn_start', 'error', 'turn_end', 'agent_end']);
  assert.equal(failed.at(-1).stopReason, 'error');
  const cancelled = run(translator, [{ type: 'turn_started' }, { type: 'turn_cancelled', revision: 1, partial_text: '' }]);
  assert.equal(cancelled.at(-1).stopReason, 'aborted');
});

test('helpers', () => {
  assert.equal(uiToolName('read_file'), 'read');
  assert.equal(uiToolName('web_fetch'), 'web_fetch');
  assert.deepEqual(diffStats(null, 'a\nb\n'), { additions: 2, deletions: 0 });
  assert.deepEqual(diffStats('a\n', null), { additions: 0, deletions: 1 });
  assert.equal(approvalDiff('p', null, null), undefined);
  // Only the changed lines and their context travel, not the whole file.
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const patch = approvalDiff('big.ts', long, long.replace('line 25', 'LINE 25'));
  assert.equal(patch.split('\n').filter((line) => line.startsWith(' ')).length, 6);
  assert.match(patch, /^-line 25$/m);
  assert.match(patch, /^\+LINE 25$/m);
});
