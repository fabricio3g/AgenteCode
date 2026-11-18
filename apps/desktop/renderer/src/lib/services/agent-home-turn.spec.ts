/**
 * A Home turn end to end on the Rust runtime path (runAgentTask →
 * home_runtime_*): the runtime is the only fake. It streams events, calls
 * Home's renderer tools and settles the turn; the tools, artifacts and
 * result shaping are real. Retries, tool-format fallbacks and loop guards
 * live in the Rust loop and are tested there.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/storage', () => ({ loadAppConfig: vi.fn(async () => ({ llm: { backend_mode: 'api', provider: 'opencode-go', providers: { 'opencode-go': { model: 'deepseek-v4.1-flash' } } } })) }));
vi.mock('$lib/services/bridge', () => ({ isElectron: () => true, invoke: vi.fn(), listen: vi.fn() }));
vi.mock('$lib/services/search', () => ({ webSearch: vi.fn(async () => []), fetchUrlContent: vi.fn() }));
vi.mock('$lib/services/live-data', () => ({ liveGeocodePlace: vi.fn(async () => ({ latitude: -34.6037, longitude: -58.3816, label: 'Buenos Aires, Argentina' })) }));

import type { ClientToolResult, RuntimeEvent } from '$shared/agente-protocol.gen';
import type { HomeRuntimeEvent } from '$shared/home-runtime';
import { invoke, listen } from './bridge';
import { INSTANT_TOOL_NAMES, runAgentTask } from './agent';
import { shouldUseToolLoop } from './composer-route';
import { homeToolRequest, planHomeAgentRun } from '$lib/features/home/home-turn';
import { matchLessonCommand } from '$lib/features/chat/lesson-entry';
import { COMPUTER_RESUME_PROMPT, COMPUTER_TASK_BUDGET, COMPUTER_TASK_PREFIX } from '$shared/computer';
import type { RunAgentTaskArgs } from './agent-types';

type Turn = { status: 'completed' | 'failed' | 'cancelled'; error?: string };
type Runtime = { emit: (event: RuntimeEvent, at?: number, parentRunId?: string) => void; call: (name: string, args: Record<string, unknown>) => Promise<ClientToolResult> };

let script: (runtime: Runtime) => Promise<Turn>;
let listener: ((event: HomeRuntimeEvent) => void) | undefined;
let starts: Array<Record<string, any>>;
let cancels: number;
const replies = new Map<string, (result: ClientToolResult) => void>();

/** What the runtime does for one started turn, driven by the test's script. */
async function drive(runId: string) {
  const send = (event: HomeRuntimeEvent) => listener?.(event);
  let calls = 0;
  const runtime: Runtime = {
    emit: (event, at = 0, parentRunId) => send({ runId, type: 'event', envelope: { session_id: 's1', turn_id: 't1', seq: 0, timestamp: new Date(at).toISOString(), parent_run_id: parentRunId, event } as never }),
    call: (name, args) => new Promise((resolve) => {
      const requestId = `request-${++calls}`;
      replies.set(requestId, resolve);
      send({ runId, type: 'call', call: { session_id: 's1', turn_id: 't1', request_id: requestId, call_id: `call-${calls}`, name, arguments: args } as never });
    })
  };
  const turn = await script(runtime);
  send({ runId, type: 'outcome', outcome: { session_id: 's1', turn_id: 't1', status: turn.status, error: turn.error ?? null } as never, snapshot: { session_id: 's1', revision: 1 } as never });
}

function run(prompt: string, extra: Partial<RunAgentTaskArgs> = {}) {
  return runAgentTask({ chatId: 'home-spec', rawPrompt: prompt, messages: [{ role: 'user', content: prompt }], agentProfile: 'chat', onStep: vi.fn(), onArtifact: vi.fn(), ...extra });
}

const say = (text: string): RuntimeEvent => ({ type: 'assistant_delta', text }) as RuntimeEvent;

describe('Home turn on the Rust runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    starts = [];
    cancels = 0;
    replies.clear();
    vi.mocked(listen).mockImplementation(async (channel: string, callback: (event: any) => void) => {
      if (channel === 'home_runtime_event') listener = callback;
      return () => { listener = undefined; };
    });
    vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
      if (command === 'home_runtime_start') {
        starts.push(args);
        queueMicrotask(() => void drive(args.runId));
        return { sessionId: 's1', turnId: 't1', conversationIndex: 0, contextWindow: 128_000 };
      }
      if (command === 'home_runtime_result') { replies.get(args.result.request_id)?.(args.result); return {}; }
      if (command === 'home_runtime_cancel') { cancels += 1; return undefined; }
      return undefined;
    });
  });

  it('answers through the runtime with the provider the chat uses', async () => {
    script = async ({ emit }) => { emit(say('Hello ')); emit(say('there.')); return { status: 'completed' }; };
    const onContent = vi.fn();
    const result = await run('hi', { onContent });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
    expect(onContent).toHaveBeenLastCalledWith('Hello there.');
    expect(result).toMatchObject({ content: 'Hello there.', outcome: 'completed' });
  });

  it('keeps per-call spend and speed through the final usage snapshot', async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 100, cache_read_tokens: 900, cache_creation_tokens: 0, context_tokens: 1000 };
    script = async ({ emit }) => {
      emit(say('First'), 1000);
      emit(say(' reply.'), 2000);
      emit({ type: 'call_usage', usage, cost_usd: 0.012, cost_estimated: false }, 9000);
      // Child costs belong to the conversation; its speed/context/content do not.
      emit(say('Child reply'), 10_000, 'child');
      emit({ type: 'call_usage', usage, cost_usd: 0.003, cost_estimated: true }, 11_000, 'child');
      emit({ type: 'usage', usage: { ...usage, completion_tokens: 0 } }, 12_000);
      return { status: 'completed' };
    };
    const onSpend = vi.fn();
    const onUsage = vi.fn();
    const result = await run('hi', { noTools: true, onSpend, onUsage });
    expect(result.content).toBe('First reply.');
    expect(result.usage).toMatchObject({ completion_tokens: 100, timings: { output_stream_ms: 1000 } });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onSpend).toHaveBeenCalledTimes(2);
    expect(result.spend).toMatchObject({ costUsd: 0.015, estimated: true, unpriced: false, promptTokens: 200, cacheReadTokens: 1800 });
  });

  it('resets the output clock across retries and leaves missing prices unpriced', async () => {
    script = async ({ emit }) => {
      emit(say('Failed attempt'), 1000);
      emit({ type: 'retry', attempt: 1, max_attempts: 2, delay_ms: 1000 } as RuntimeEvent, 2000);
      emit(say('Buffered reply.'), 10_000);
      emit({ type: 'call_usage', usage: { prompt_tokens: 10, completion_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0, context_tokens: 10 }, cost_usd: null, cost_estimated: true }, 20_000);
      return { status: 'completed' };
    };
    const result = await run('hi', { noTools: true });
    expect(result.usage?.timings).toBeUndefined();
    expect(result.spend).toMatchObject({ costUsd: 0, unpriced: true });
  });

  it('starts a goal created before the first turn on its reserved session', async () => {
    script = async ({ emit }) => { emit(say('Working.')); return { status: 'completed' }; };
    await run('hi', { homeRuntime: { sessionId: 'goal-session', goalPending: true, revision: 0, provider: '', model: '', contextWindow: 0, historyIds: [] }, historyIds: ['user-1'] });
    expect(starts[0].sessionId).toBe('goal-session');
    expect(starts[0].conversation).toBeDefined();
  });

  it('imports edited history into the existing goal session', async () => {
    script = async ({ emit }) => { emit(say('Working.')); return { status: 'completed' }; };
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
      if (command === 'agente_goal_get') return { objective: 'Finish work', phase: 'working' };
      return original(command, args);
    });
    await run('hi', { homeRuntime: { sessionId: 'old-session', revision: 1, provider: 'p', model: 'm', contextWindow: 100, historyIds: ['old'] }, historyIds: ['edited', 'new'] });
    expect(starts[0].sessionId).toBe('old-session');
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('agente_goal_set', expect.anything());
    expect(starts[0].conversation).toBeDefined();
  });

  it('keeps the Rust context budget when provider usage arrives afterward', async () => {
    script = async ({ emit }) => {
      emit({ type: 'context_budget', used: 40_000, room: 80_000, window: 100_000, tool_tokens: 8_000, gap: 2_000, reserve: 10_000, system_tokens: 4_000, message_tokens: 30_000, tool_result_tokens: 6_000 } as RuntimeEvent);
      emit({ type: 'usage', usage: { prompt_tokens: 50_000, completion_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0, context_tokens: 50_000 } } as RuntimeEvent);
      emit(say('Done.'));
      return { status: 'completed' };
    };
    const onRuntime = vi.fn();
    await run('hi', { onRuntime });
    expect(onRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ contextWindow: 80_000, contextTokens: 40_000, estimated: true, contextBreakdown: expect.objectContaining({ system: 4_000 }) }));
  });

  it('runs a plain Instant answer as one tool-less runtime turn', async () => {
    script = async ({ emit }) => { emit(say('Four.')); return { status: 'completed' }; };
    const result = await run('what is 2+2', { toolMode: 'instant', noTools: true });
    expect(starts[0].tools).toEqual([]);
    expect(starts[0].policy.max_iterations).toBe(1);
    expect(result.content).toBe('Four.');
  });

  it('offers the lesson tool for a Teach request from Instant mode', async () => {
    script = async ({ emit }) => { emit(say('Here is a lesson.')); return { status: 'completed' }; };
    const prompt = matchLessonCommand('/teach the chain rule', 'home')!.directive;
    const plan = planHomeAgentRun({ composerMode: 'instant', searchMode: 'deep', request: homeToolRequest(prompt, 'home') });
    await run(prompt, { contextMode: 'home', toolMode: plan.toolMode, agentProfile: plan.agentProfile, config: { ui: { artifact_toggles: { lesson: true } } } });
    expect(starts[0].tools).toContainEqual(expect.objectContaining({ name: 'create_lesson' }));
  });

  it.each([`${COMPUTER_TASK_PREFIX}open Settings`, COMPUTER_RESUME_PROMPT])('keeps computer tools enabled for %s from Instant mode', async prompt => {
    script = async ({ emit }) => { emit(say('Ready.')); return { status: 'completed' }; };
    const plan = planHomeAgentRun({ composerMode: 'instant', searchMode: 'chat', request: homeToolRequest(prompt, 'home') });
    await run(prompt, { contextMode: 'home', toolMode: plan.toolMode, ...plan.budget });
    expect(starts[0]).toMatchObject({ computerEnabled: true, computerRequested: true, policy: { max_iterations: COMPUTER_TASK_BUDGET.maxIterations } });
  });

  it('runs a Home tool the runtime calls and publishes its artifact', async () => {
    let reply: ClientToolResult | undefined;
    script = async ({ emit, call }) => {
      reply = await call('create_map', { place: 'Buenos Aires, Argentina', zoom: 12 });
      emit(say('Here is Buenos Aires.'));
      return { status: 'completed' };
    };
    const onArtifact = vi.fn();
    const result = await run('Show me a map of Buenos Aires', { onArtifact });
    expect(starts[0].tools.map((tool: { name: string }) => tool.name)).toContain('create_map');
    expect(reply).toMatchObject({ request_id: 'request-1', is_error: false });
    expect(result.artifact?.inline).toMatchObject({ kind: 'map', latitude: -34.6037, longitude: -58.3816, zoom: 12 });
    expect(onArtifact).toHaveBeenLastCalledWith(result.artifacts);
    expect(result.content).toBe('Here is Buenos Aires.');
  });

  it('answers a tool the turn does not have with an error the model can read', async () => {
    let reply: ClientToolResult | undefined;
    script = async ({ emit, call }) => { reply = await call('format_disk', {}); emit(say('I cannot do that.')); return { status: 'completed' }; };
    await run('wipe it');
    expect(reply?.is_error).toBe(true);
    expect(reply?.content).toMatch(/disabled/);
  });

  it('streams reasoning and keeps an ordinary code example out of the files', async () => {
    script = async ({ emit }) => {
      emit({ type: 'reasoning_delta', text: 'Show a snippet.' } as RuntimeEvent);
      emit(say('Use this:\n```js\nconsole.log(1)\n```'));
      return { status: 'completed' };
    };
    const onReasoning = vi.fn();
    const result = await run('how do I log in js?', { onReasoning });
    expect(onReasoning).toHaveBeenLastCalledWith('Show a snippet.');
    expect(result.artifacts).toEqual([]);
    expect(starts).toHaveLength(1);
  });

  it('reports a failed turn as failed, not as a delivered answer', async () => {
    script = async () => ({ status: 'failed', error: 'The provider is down.' });
    const result = await run('hi');
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('provider');
  });

  it('settles with an error when a tool reply cannot reach the runtime', async () => {
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command: string, args?: any) => {
      if (command === 'home_runtime_result') throw new Error('Runtime tool reply disconnected');
      return original(command, args);
    });
    script = async ({ call }) => { await call('calculator', { expression: '2+2' }); return { status: 'completed' }; };
    const result = await run('calculate 2+2');
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('disconnected');
    expect(cancels).toBeGreaterThan(0);
  });

  it('cancels the runtime turn when the user stops it', async () => {
    const controller = new AbortController();
    script = async ({ call }) => {
      const pending = call('web_search', { query: 'news' });
      controller.abort();
      void pending;
      return { status: 'cancelled' };
    };
    const result = await run('latest news', { signal: controller.signal });
    expect(cancels).toBeGreaterThan(0);
    expect(result.outcome).toBe('stopped');
  });

  describe('when the iteration budget runs out', () => {
    const notice = 'Reached the iteration limit (4) for this turn. The task is paused; send another message to continue.';
    const wrapUp = 'Finished the summary. Left: the second source. Ask me to continue.';
    const streamed = (onContent: ReturnType<typeof vi.fn>) => onContent.mock.calls.map((call) => String(call[0]));

    it('replaces the notice with one tool-less wrap-up on the same session', async () => {
      script = async ({ emit }) => {
        if (starts.length === 1) {
          emit(say('Checking the second source.'));
          emit({ type: 'assistant_message', text: notice } as RuntimeEvent);
        } else {
          emit(say(wrapUp));
        }
        return { status: 'completed' };
      };
      const onContent = vi.fn();
      const result = await run('hi', { onContent });
      expect(starts).toHaveLength(2);
      expect(starts[0].tools.length).toBeGreaterThan(0);
      expect(starts[1]).toMatchObject({ sessionId: 's1', tools: [], policy: { max_iterations: 1, max_tool_calls: 0 } });
      expect(starts[1].prompt.content).toMatch(/step budget\. Do not call tools/);
      expect(starts[1]).not.toHaveProperty('wrapUp');
      const texts = streamed(onContent);
      expect(texts.indexOf(notice)).toBeLessThan(texts.lastIndexOf(''));
      expect(texts.at(-1)).toBe(wrapUp);
      expect(result).toMatchObject({ content: wrapUp, outcome: 'completed', stopReason: 'iteration_limit' });
    });

    it('never starts a second wrap-up, even when the wrap-up runs out too', async () => {
      script = async ({ emit }) => {
        emit({ type: 'assistant_message', text: notice } as RuntimeEvent);
        return { status: 'completed' };
      };
      const result = await run('hi');
      expect(starts).toHaveLength(2);
      expect(result).toMatchObject({ content: notice, outcome: 'completed', stopReason: 'iteration_limit' });
    });

    it('keeps the notice as the reply when the provider refuses the wrap-up', async () => {
      const onContent = vi.fn();
      script = async ({ emit }) => {
        if (starts.length > 1) return { status: 'failed', error: 'The provider rejected the request.' };
        emit({ type: 'assistant_message', text: notice } as RuntimeEvent);
        return { status: 'completed' };
      };
      const result = await run('hi', { onContent });
      expect(starts).toHaveLength(2);
      expect(result).toMatchObject({ content: notice, outcome: 'completed', stopReason: 'iteration_limit' });
      expect(result.error).toBeUndefined();
      expect(streamed(onContent).at(-1)).toBe(notice);
    });

    it('keeps the notice as the reply when the wrap-up comes back empty', async () => {
      const onContent = vi.fn();
      script = async ({ emit }) => {
        if (starts.length === 1) emit({ type: 'assistant_message', text: notice } as RuntimeEvent);
        return { status: 'completed' };
      };
      const result = await run('hi', { onContent });
      expect(starts).toHaveLength(2);
      expect(result).toMatchObject({ content: notice, outcome: 'completed', stopReason: 'iteration_limit' });
      expect(streamed(onContent).at(-1)).toBe(notice);
    });

    it('does not wrap up a run the user stopped', async () => {
      const controller = new AbortController();
      script = async ({ emit }) => {
        emit({ type: 'assistant_message', text: notice } as RuntimeEvent);
        controller.abort();
        return { status: 'cancelled' };
      };
      const result = await run('hi', { signal: controller.signal });
      expect(starts).toHaveLength(1);
      expect(result.outcome).toBe('stopped');
    });

    it('leaves an ordinary completed reply alone', async () => {
      script = async ({ emit }) => {
        emit(say('All done.'));
        return { status: 'completed' };
      };
      const result = await run('hi');
      expect(starts).toHaveLength(1);
      expect(result).toMatchObject({ content: 'All done.', outcome: 'completed', stopReason: 'none' });
    });
  });
});

describe('Home routing', () => {
  it('honors the explicit Agent choice even with automatic routing', () => {
    expect(shouldUseToolLoop({ control: 'auto', composerMode: 'agent', route: 'conversation', contextMode: 'home' })).toBe(true);
  });

  it('Instant tools cover grounding and math, never files or artifacts', () => {
    for (const name of ['web_search', 'fetch_url', 'query_knowledge', 'calculator', 'get_weather', 'convert_currency', 'get_quote']) {
      expect(INSTANT_TOOL_NAMES.has(name)).toBe(true);
    }
    for (const name of ['create_chart', 'create_map', 'create_work_product', 'create_document', 'write_file', 'edit_file', 'delete_file', 'preview_project']) {
      expect(INSTANT_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});
