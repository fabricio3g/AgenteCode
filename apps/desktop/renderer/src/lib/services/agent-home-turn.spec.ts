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
import type { RunAgentTaskArgs } from './agent-types';

type Turn = { status: 'completed' | 'failed' | 'cancelled'; error?: string };
type Runtime = { emit: (event: RuntimeEvent) => void; call: (name: string, args: Record<string, unknown>) => Promise<ClientToolResult> };

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
    emit: (event) => send({ runId, type: 'event', envelope: { session_id: 's1', turn_id: 't1', seq: 0, event } as never }),
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

  it('runs a plain Instant answer as one tool-less runtime turn', async () => {
    script = async ({ emit }) => { emit(say('Four.')); return { status: 'completed' }; };
    const result = await run('what is 2+2', { toolMode: 'instant', noTools: true });
    expect(starts[0].tools).toEqual([]);
    expect(starts[0].policy.max_iterations).toBe(1);
    expect(result.content).toBe('Four.');
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
