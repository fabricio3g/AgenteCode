import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '$shared/agent-core/types';
import { ensureToolCallPairs } from '$lib/services/agent-message-context';
import { buildWireMessages, type AgentRun } from '$lib/services/agent-run-context';

function runWith(transcript: AgentMessage[], options: { nativeIds?: string[]; nativeTools?: boolean; nativeFailed?: boolean } = {}): AgentRun {
  return {
    plan: { nativeTools: options.nativeTools ?? true, prompts: { native: 'native-sys', xml: 'xml-sys', direct: 'direct-sys' } },
    transport: { nativeFailed: !!options.nativeFailed, directMode: false },
    history: [{ role: 'user', content: 'question' }],
    transcript,
    nativeCallIds: new Set(options.nativeIds || [])
  } as unknown as AgentRun;
}

const call = (id: string, name = 'calculator') => ({ id, name, arguments: { expression: '1+1' } });

describe('buildWireMessages', () => {
  it('keeps native calls paired as assistant tool_calls + tool results', () => {
    const wire = buildWireMessages(runWith([
      { role: 'assistant', content: '', toolCalls: [call('call_1')], reasoning_content: 'think', stopReason: 'toolUse', ts: 1 },
      { role: 'tool', toolCallId: 'call_1', toolName: 'calculator', content: '{"result":2}', isError: false, ts: 2 }
    ], { nativeIds: ['call_1'] }));
    expect(wire[0]).toEqual({ role: 'system', content: 'native-sys' });
    expect(wire[2]).toMatchObject({ role: 'assistant', reasoning_content: 'think', tool_calls: [{ id: 'call_1', function: { name: 'calculator' } }] });
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', name: 'calculator' });
  });

  it('sends text-dialect results back as plain text, which the pairing pass keeps', () => {
    // A `tool` message after a text-dialect turn has no tool_calls parent, so the
    // pairing pass would delete it as an orphan and the model would never see its result.
    const wire = buildWireMessages(runWith([
      { role: 'assistant', content: 'Let me calculate.', toolCalls: [call('text-1-0')], stopReason: 'toolUse', ts: 1 },
      { role: 'tool', toolCallId: 'text-1-0', toolName: 'calculator', content: '{"result":2}', isError: false, details: { payload: { result: 2 } }, ts: 2 }
    ], { nativeTools: false }));
    expect(wire[0]).toEqual({ role: 'system', content: 'xml-sys' });
    expect(wire[2]).toEqual({ role: 'assistant', content: 'Let me calculate.' });
    expect(wire[3]?.role).toBe('user');
    expect(String(wire[3]?.content)).toContain('Tool result for calculator');
    expect(String(wire[3]?.content)).toContain('"result": 2');

    ensureToolCallPairs(wire, 'fill');
    expect(wire).toHaveLength(4);
  });

  it('keeps earlier native pairs after native tools fail mid-run', () => {
    const wire = buildWireMessages(runWith([
      { role: 'assistant', content: '', toolCalls: [call('call_9')], stopReason: 'toolUse', ts: 1 },
      { role: 'tool', toolCallId: 'call_9', toolName: 'calculator', content: '{}', isError: false, ts: 2 }
    ], { nativeIds: ['call_9'], nativeFailed: true }));
    expect(wire[0]).toEqual({ role: 'system', content: 'xml-sys' });
    expect(wire[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_9' });
  });

  it('never sends failed calls back to the provider', () => {
    const wire = buildWireMessages(runWith([
      { role: 'assistant', content: '', stopReason: 'error', errorMessage: 'socket hang up', ts: 1 },
      { role: 'user', content: 'nudge', ts: 2 }
    ]));
    expect(wire.map((message) => message.role)).toEqual(['system', 'user', 'user']);
  });
});
