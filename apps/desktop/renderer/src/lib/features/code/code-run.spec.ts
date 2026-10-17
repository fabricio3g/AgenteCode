import { describe, it, expect, vi } from 'vitest';
import { applyCodeAgentEvent, codeRunElapsed, createCodeRunState, orderedEntries } from './code-run';
import type { CodeAgentEvent } from '$shared/agente-protocol';

function run(events: CodeAgentEvent[]) {
  const state = createCodeRunState();
  for (const event of events) applyCodeAgentEvent(state, event);
  return state;
}

describe('agente run reducer', () => {
  it('keeps measured generation speed available without adding transcript rows', () => {
    const state = createCodeRunState();
    expect(applyCodeAgentEvent(state, { type:'generation_stats', chatId:'c', tokensPerSecond:55.2 })).toBe(false);
    expect(state.tokensPerSecond).toBe(55.2);
    expect(state.timeline).toEqual([]);
    applyCodeAgentEvent(state, { type:'generation_stats', chatId:'c', tokensPerSecond:NaN });
    expect(state.tokensPerSecond).toBe(55.2);
  });
  it('keeps subagent text and tool output separate, counting child spend once in the session', () => {
    const state = run([
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_started', run_id: 'child', kind: 'explore', description: 'Check tests', model: 'test-model' } },
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_delta', run_id: 'child', text: 'Looking.' } },
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_tool', run_id: 'child', call_id: 'tool', name: 'read_file', content: 'src/a.ts', finished: false, is_error: false } },
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_tool', run_id: 'child', call_id: 'tool', name: '', content: 'actual output', finished: true, is_error: false } },
      { type: 'runtime_event', chatId: 'c', parentRunId: 'child', event: { type: 'call_usage', cost_usd: 0.01, cost_estimated: false, usage: { prompt_tokens: 100, completion_tokens: 10, cache_read_tokens: 900, cache_creation_tokens: 0 } } },
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_finished', run_id: 'child', summary: 'All good', is_error: false } }
    ]);
    expect(state.content).toBe('');
    expect(state.steps).toHaveLength(0);
    expect(state.children[0]).toMatchObject({ text: 'Looking.', summary: 'All good', status: 'done', tools: [{ name: 'read_file', output: 'actual output', status: 'done' }] });
    expect(state.spend.costUsd).toBe(0.01);
    expect(state.children[0]!.spend.costUsd).toBe(0.01);
  });
  it('retains complete child replies and completed tool results beyond the live preview limit', () => {
    const text = '日'.repeat(150000) + 'FINAL EVIDENCE';
    const state = run([
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_started', run_id: 'child', kind: 'explore', description: 'Large result', model: 'test-model' } },
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_delta', run_id: 'child', text } },
      { type: 'runtime_event', chatId: 'c', event: { type: 'child_tool', run_id: 'child', call_id: 'tool', name: 'task_output', content: text, finished: true, is_error: false } }
    ]);
    expect(state.children[0]!.text).toBe(text);
    expect(state.children[0]!.tools[0]!.output).toBe(text);
  });

  it('accumulates text and thinking deltas', () => {
    const state = run([
      { type: 'text_delta', chatId: 'c', delta: 'Hello ' },
      { type: 'text_delta', chatId: 'c', delta: 'world' },
      { type: 'thinking_delta', chatId: 'c', delta: 'hmm' }
    ]);
    expect(state.content).toBe('Hello world');
    expect(state.reasoning).toBe('hmm');
  });

  it('keeps one thought and one reply when the provider interleaves them per chunk', () => {
    // OpenRouter and several gateways stream `reasoning` and `content` in the
    // same chunk, so every chunk produced a thinking delta and a text delta and
    // the reply was drawn as alternating fragments of one sentence.
    const state = run([
      { type: 'thinking_delta', chatId: 'c', delta: 'Two bugs to fix: ' },
      { type: 'text_delta', chatId: 'c', delta: 'Let' },
      { type: 'thinking_delta', chatId: 'c', delta: 'a temporary spec.' },
      { type: 'text_delta', chatId: 'c', delta: ' me find whether this is the store' }
    ]);
    expect(state.timeline).toEqual([
      { kind: 'thinking', text: 'Two bugs to fix: a temporary spec.' },
      { kind: 'text', text: 'Let me find whether this is the store' }
    ]);
    expect(state.content).toBe('Let me find whether this is the store');
  });

  it('still gives a second thought its own row after a tool call', () => {
    const state = run([
      { type: 'thinking_delta', chatId: 'c', delta: 'first thought' },
      { type: 'text_delta', chatId: 'c', delta: 'First.' },
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'thinking_delta', chatId: 'c', delta: 'second thought' },
      { type: 'text_delta', chatId: 'c', delta: 'Second.' }
    ]);
    expect(state.timeline.map((entry) => entry.kind)).toEqual(['thinking', 'text', 'step', 'thinking', 'text']);
  });

  it('tracks a tool call from start to end', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'tool_update', chatId: 'c', toolCallId: 't1', partialResult: 'partial' },
      { type: 'tool_end', chatId: 'c', toolCallId: 't1', result: 'file body', isError: false }
    ]);
    const step = state.steps.find((s) => s.id === 't1');
    expect(step?.status).toBe('done');
    expect(step?.output).toBe('file body');
    expect(step?.detail).toContain('a.ts');
  });

  it('marks errored tools and surfaces the error message', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: { command: 'exit 1' } },
      { type: 'tool_end', chatId: 'c', toolCallId: 't1', result: 'boom', isError: true }
    ]);
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('resolves approval steps when the decision arrives', () => {
    const state = run([
      { type: 'approval_request', chatId: 'c', requestId: 'apr-1', toolName: 'write', args: { path: 'x' }, diff: '+++ x' },
      { type: 'approval_resolved', chatId: 'c', requestId: 'apr-1', decision: 'deny' }
    ]);
    const step = state.steps.find((s) => s.id === 'apr-1');
    expect(step?.status).toBe('error');
    expect(step?.detail).toBe('Denied');
  });

  it('attaches checkpoint diffstats to writing steps', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 'w1', toolName: 'write', args: { path: 'a.ts' } },
      {
        type: 'checkpoint_finalized',
        chatId: 'c',
        turnIndex: 1,
        files: [{ path: 'a.ts', additions: 10, deletions: 2, kind: 'modified' }]
      }
    ]);
    const write = state.steps.find((s) => s.id === 'w1');
    expect(write?.diffStats?.[0]).toMatchObject({ path: 'a.ts', additions: 10, deletions: 2 });
    expect(state.fileChanges).toHaveLength(1);
  });

  it('completes the run on agent_end and closes stray running steps', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'agent_end', chatId: 'c', stopReason: 'stop' }
    ]);
    expect(state.done).toBe(true);
    expect(state.stopReason).toBe('stop');
    // No error was reported, so the stray step is closed as done — not
    // punished as a failure.
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('done');
  });

  it('marks a stray running step error when the run failed', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'error', chatId: 'c', message: 'provider unreachable' },
      { type: 'agent_end', chatId: 'c', stopReason: 'error' }
    ]);
    expect(state.done).toBe(true);
    expect(state.error).toBe('provider unreachable');
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('records error events', () => {
    const state = run([{ type: 'error', chatId: 'c', message: 'no model' }]);
    expect(state.error).toBe('no model');
  });

  it('finalizes the run on error even when agent_end never follows', () => {
    // The engine's prompt() rejection path emits `error` as the last event.
    // Without finalizing here the assistant placeholder streamed forever.
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'bash', args: {} },
      { type: 'error', chatId: 'c', message: 'prompt failed' }
    ]);
    expect(state.done).toBe(true);
    expect(state.stopReason).toBe('error');
    expect(state.error).toBe('prompt failed');
    expect(state.steps.find((s) => s.id === 't1')?.status).toBe('error');
  });

  it('captures the end-of-run stop reason', () => {
    const state = run([{ type: 'agent_end', chatId: 'c', stopReason: 'length' }]);
    expect(state.stopReason).toBe('length');
  });

  it('shows and clears the retry notice around content', () => {
    const state = run([
      { type: 'llm_retry', chatId: 'c', attempt: 1, delayMs: 1000 }
    ]);
    expect(state.retrying).toEqual({ attempt: 1, delayMs: 1000 });
    applyCodeAgentEvent(state, { type: 'text_delta', chatId: 'c', delta: 'back online' });
    expect(state.retrying).toBeNull();
  });

  it('drops a broken turn\'s partial text when the loop replays it', () => {
    const state = run([
      { type: 'turn_start', chatId: 'c', turnIndex: 1 },
      { type: 'text_delta', chatId: 'c', delta: 'First turn done.' },
      { type: 'turn_start', chatId: 'c', turnIndex: 2 },
      { type: 'text_delta', chatId: 'c', delta: ' Half a senten' },
      { type: 'llm_retry', chatId: 'c', attempt: 1, delayMs: 1000, discardPartial: true },
      { type: 'text_delta', chatId: 'c', delta: ' A whole sentence.' }
    ]);
    expect(state.content).toBe('First turn done. A whole sentence.');
  });

  it('records a truncated turn without adding a row for it', () => {
    const state = run([
      { type: 'length_continue', chatId: 'c', turnIndex: 2 }
    ]);
    expect(state.truncatedOnce).toBe(true);
    expect(state.steps).toEqual([]);
  });

  it('keeps text and tool steps in the order they happened', () => {
    const state = run([
      { type: 'agent_start', chatId: 'c' },
      { type: 'turn_start', chatId: 'c', turnIndex: 1 },
      { type: 'text_delta', chatId: 'c', delta: 'Let me look ' },
      { type: 'text_delta', chatId: 'c', delta: 'first.' },
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'read', args: { path: 'src/index.ts' } },
      { type: 'tool_end', chatId: 'c', toolCallId: 't1', result: 'ok', isError: false },
      { type: 'turn_end', chatId: 'c', turnIndex: 1 },
      { type: 'text_delta', chatId: 'c', delta: 'Done.' }
    ]);
    expect(state.timeline).toEqual([
      { kind: 'text', text: 'Let me look first.' },
      { kind: 'step', id: 't1' },
      { kind: 'text', text: 'Done.' }
    ]);
    // Consecutive turns no longer run together in the joined text.
    expect(state.content).toBe('Let me look first.\n\nDone.');
    // Turns are not rows.
    expect(state.steps.map((step) => step.id)).toEqual(['t1']);
    expect(state.startedAt).toBeTypeOf('number');
  });

  it('describes tool calls instead of dumping JSON', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 'r', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'tool_start', chatId: 'c', toolCallId: 'b', toolName: 'bash', args: { command: 'npm test\necho done' } },
      { type: 'tool_start', chatId: 'c', toolCallId: 'g', toolName: 'grep', args: { pattern: 'TODO', path: 'src' } }
    ]);
    expect(state.steps.map((step) => [step.label, step.detail, step.toolName])).toEqual([
      ['Read', 'a.ts', 'read'],
      ['Run', 'npm test', 'bash'],
      ['Search', '“TODO” · src', 'grep']
    ]);
  });

  it('ignores non-text progress updates instead of printing [object Object]', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 'b', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_update', chatId: 'c', toolCallId: 'b', partialResult: { status: 'running' } },
      { type: 'tool_update', chatId: 'c', toolCallId: 'b', partialResult: { output: 'file.txt' } }
    ]);
    expect(state.steps[0]?.output).toBe('file.txt');
  });

  it('flags a run that ran out of turns', () => {
    const state = run([{ type: 'agent_end', chatId: 'c', stopReason: 'stop', hitTurnLimit: true }]);
    expect(state.hitTurnLimit).toBe(true);
  });

  it('replaces the todo list on todo_update', () => {
    const state = run([
      {
        type: 'todo_update',
        chatId: 'c',
        todos: [
          { content: 'read files', status: 'completed' },
          { content: 'edit config', status: 'in_progress' },
          { content: 'run tests', status: 'pending' }
        ]
      }
    ]);
    expect(state.todos).toHaveLength(3);
    expect(state.todos[1]).toEqual({ content: 'edit config', status: 'in_progress' });
  });
});

describe('agente run reducer (#9 Home-facing events)', () => {
  it('collects artifact references without touching the transcript', () => {
    const state = createCodeRunState();
    const created = applyCodeAgentEvent(state, {
      type: 'artifact_created',
      chatId: 'c',
      artifact: { kind: 'chart', entryPath: 'chart.json', title: 'Sales' }
    });
    expect(created).toBe(false);
    expect(state.artifacts).toEqual([{ kind: 'chart', entryPath: 'chart.json', title: 'Sales' }]);
    const listed = applyCodeAgentEvent(state, {
      type: 'artifact_list',
      chatId: 'c',
      artifacts: [{ kind: 'report', entryPath: 'r.md' }]
    });
    expect(listed).toBe(false);
    expect(state.artifacts).toEqual([{ kind: 'report', entryPath: 'r.md' }]);
  });

  it('replaces sources wholesale but dedupes deltas by url', () => {
    const state = run([
      { type: 'sources', chatId: 'c', sources: [{ title: 'A', url: 'https://a.test' }] },
      {
        type: 'sources_delta',
        chatId: 'c',
        sources: [
          { title: 'A again', url: 'https://a.test' },
          { title: 'B', url: 'https://b.test', snippet: 'hi' }
        ]
      }
    ]);
    expect(state.sources.map((s) => s.url)).toEqual(['https://a.test', 'https://b.test']);
  });

  it('tracks the canonical activity key', () => {
    const state = run([{ type: 'activity', chatId: 'c', activity: 'searching' }]);
    expect(state.activity).toBe('searching');
  });

  it('replaces streamed content on content_replace', () => {
    const state = run([
      { type: 'text_delta', chatId: 'c', delta: 'partial…' },
      { type: 'content_replace', chatId: 'c', content: 'Final synthesized answer.' }
    ]);
    expect(state.content).toBe('Final synthesized answer.');
  });

  it('finalizes the run when run_summary carries an error, stores clean summaries', () => {
    const failed = run([
      {
        type: 'run_summary',
        chatId: 'c',
        summary: { outcome: 'failed', homeStopReason: 'error', error: 'provider blew up' }
      }
    ]);
    expect(failed.done).toBe(true);
    expect(failed.stopReason).toBe('error');
    expect(failed.error).toBe('provider blew up');
    expect(failed.summary?.outcome).toBe('failed');

    const clean = run([
      {
        type: 'run_summary',
        chatId: 'c',
        summary: {
          outcome: 'completed',
          homeStopReason: 'none',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
        }
      }
    ]);
    expect(clean.done).toBe(false);
    expect(clean.summary?.usage?.totalTokens).toBe(15);
  });

  it('prefers engine-supplied step label/detail and tool_end file metadata', () => {
    const state = run([
      { type: 'tool_start', chatId: 'c', toolCallId: 't1', toolName: 'write', args: { path: 'a.ts' }, label: 'Writing a.ts', detail: 'Create a.ts (12 bytes)' },
      {
        type: 'tool_end',
        chatId: 'c',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
        status: 'done',
        fileChanges: [{ path: 'a.ts', kind: 'created' }],
        diffStats: [{ path: 'a.ts', kind: 'created', additions: 12, deletions: 0 }]
      }
    ]);
    const step = state.steps.find((s) => s.id === 't1');
    expect(step?.label).toBe('Writing a.ts');
    expect(step?.detail).toBe('Create a.ts (12 bytes)');
    expect(step?.fileChanges).toEqual([{ path: 'a.ts', kind: 'created' }]);
    expect(step?.diffStats).toEqual([{ path: 'a.ts', kind: 'created', additions: 12, deletions: 0 }]);
  });

  it('normalizes reasoning with the shared rule across chunk splits', () => {
    const state = run([
      { type: 'thinking_delta', chatId: 'c', delta: 'still ' },
      { type: 'thinking_delta', chatId: 'c', delta: 'thinking' }
    ]);
    expect(state.reasoning).toBe('still thinking');
    expect(state.reasoningRaw).toBe('still thinking');
  });
});

describe('orderedEntries', () => {
  const read = { id: 'r', type: 'reading' as const, label: 'Read', status: 'done' as const };

  it('renders a saved timeline in order and skips blank text', () => {
    const entries = orderedEntries({
      agentSteps: [read],
      content: 'a\n\nb',
      metadata: { codeTimeline: [{ kind: 'text', text: 'a' }, { kind: 'step', id: 'r' }, { kind: 'text', text: '  ' }, { kind: 'text', text: 'b' }] }
    });
    expect(entries.map((entry) => entry.text ?? entry.step?.id)).toEqual(['a', 'r', 'b']);
  });

  it('falls back to steps then text for messages saved before timelines', () => {
    const entries = orderedEntries({ agentSteps: [read], content: 'answer' });
    expect(entries.map((entry) => entry.text ?? entry.step?.id)).toEqual(['r', 'answer']);
  });

  it('drops bookkeeping rows: turns and output-cap notes; the todo update becomes the plan card', () => {
    const turn = { id: 'turn-1', type: 'done' as const, label: 'Turn 1 complete', status: 'done' as const };
    const cap = { id: 'length-2', type: 'planning' as const, label: 'Hit the output cap', status: 'done' as const };
    const todo = { id: 't', type: 'tool' as const, label: 'Update tasks', toolName: 'todo_write', status: 'done' as const };
    const entries = orderedEntries({ agentSteps: [turn, cap, todo, read], content: '' });
    expect(entries.map((entry) => (entry.plan ? 'plan' : entry.step?.id))).toEqual(['plan', 'r']);
  });
});


describe('active run timing', () => {
  it('excludes an idle stop/resume gap and freezes the stopped timer', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const state = createCodeRunState();
      applyCodeAgentEvent(state, { type: 'agent_start', chatId: 'c' });
      vi.setSystemTime(61000);
      applyCodeAgentEvent(state, { type: 'agent_end', chatId: 'c', stopReason: 'aborted' });
      vi.setSystemTime(600000);
      expect(codeRunElapsed(state)).toBe(60000);
      applyCodeAgentEvent(state, { type: 'agent_start', chatId: 'c' });
      vi.setSystemTime(630000);
      expect(codeRunElapsed(state)).toBe(90000);
      applyCodeAgentEvent(state, { type: 'agent_end', chatId: 'c', stopReason: 'stop' });
      vi.setSystemTime(900000);
      expect(codeRunElapsed(state)).toBe(90000);
    } finally { vi.useRealTimers(); }
  });
  it('clears timestamps when an existing store object is reset for a new turn', () => {
    const state = createCodeRunState();
    state.startedAt = 1000; state.endedAt = 3000; state.elapsedMs = 2000;
    Object.assign(state, createCodeRunState());
    expect(state.startedAt).toBeUndefined();
    expect(state.endedAt).toBeUndefined();
    expect(codeRunElapsed(state, 900000)).toBe(0);
  });
  it('stops counting if an error arrives without an end event', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const state = createCodeRunState();
      applyCodeAgentEvent(state, { type: 'agent_start', chatId: 'c' });
      vi.setSystemTime(11000);
      applyCodeAgentEvent(state, { type: 'error', chatId: 'c', message: 'Disconnected' });
      vi.setSystemTime(91000);
      expect(codeRunElapsed(state)).toBe(10000);
      applyCodeAgentEvent(state, { type: 'agent_end', chatId: 'c', stopReason: 'error' });
      expect(codeRunElapsed(state)).toBe(10000);
    } finally { vi.useRealTimers(); }
  });
});

it('keeps reused provider tool IDs in chronological rows instead of overwriting older work', () => {
  const state = run([
    {type:'tool_start',chatId:'c',toolCallId:'call_0',toolName:'read',args:{path:'first.ts'}},
    {type:'tool_end',chatId:'c',toolCallId:'call_0',result:'First result',isError:false},
    {type:'text_delta',chatId:'c',delta:'Next I will edit.'},
    {type:'tool_start',chatId:'c',toolCallId:'call_0',toolName:'edit',args:{path:'second.ts'}},
    {type:'tool_end',chatId:'c',toolCallId:'call_0',result:'Second result',isError:false},
    {type:'tool_update',chatId:'c',toolCallId:'call_0',partialResult:'Late heartbeat'}
  ]);
  expect(state.steps.map(step=>[step.detail,step.output,step.status])).toEqual([['first.ts','First result','done'],['second.ts','Second result','done']]);
  expect(orderedEntries({agentSteps:state.steps,content:state.content},state.timeline).map(entry=>entry.step?.detail || entry.text)).toEqual(['first.ts','Next I will edit.','second.ts']);
});
it('preserves submission order when parallel tools finish in reverse order', () => {
  const state=run([
    {type:'tool_start',chatId:'c',toolCallId:'a',toolName:'read',args:{path:'a.ts'}},
    {type:'tool_start',chatId:'c',toolCallId:'b',toolName:'read',args:{path:'b.ts'}},
    {type:'tool_end',chatId:'c',toolCallId:'b',result:'B',isError:false},
    {type:'tool_end',chatId:'c',toolCallId:'a',result:'A',isError:false}
  ]);
  expect(orderedEntries({agentSteps:state.steps,content:''},state.timeline).map(entry=>entry.step?.output)).toEqual(['A','B']);
});

it('keeps each invocation when a subagent reuses a provider tool ID',()=>{
  const state=run([
    {type:'runtime_event',chatId:'c',event:{type:'child_started',run_id:'child',kind:'explore',description:'Inspect',model:'test'}},
    {type:'runtime_event',chatId:'c',event:{type:'child_tool',run_id:'child',call_id:'call_0',name:'read_file',content:'a.ts',finished:false,is_error:false}},
    {type:'runtime_event',chatId:'c',event:{type:'child_tool',run_id:'child',call_id:'call_0',name:'',content:'A result',finished:true,is_error:false}},
    {type:'runtime_event',chatId:'c',event:{type:'child_tool',run_id:'child',call_id:'call_0',name:'read_file',content:'b.ts',finished:false,is_error:false}},
    {type:'runtime_event',chatId:'c',event:{type:'child_tool',run_id:'child',call_id:'call_0',name:'',content:'B result',finished:true,is_error:false}}
  ]);
  expect(state.children[0]!.tools.map(tool=>tool.output)).toEqual(['A result','B result']);
});
