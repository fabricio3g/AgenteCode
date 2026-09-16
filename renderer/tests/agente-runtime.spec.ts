import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentTool, AssistantMessage, StreamFn } from '../../shared/agent-core/types.ts';
import type { CodeAgentEvent, AgenteRuntimeMode } from '../../shared/agente-protocol.ts';
import type { AgenteExtensionDefinition } from '../../main/agente/extensions/extension-api.ts';

const host = vi.hoisted(() => ({
  appData: '',
  stream: vi.fn<StreamFn>(),
  tools: [] as AgentTool[],
  extensions: [] as AgenteExtensionDefinition[],
  emit: vi.fn<(sender: unknown, event: CodeAgentEvent) => void>()
}));
vi.mock('../../main/config.ts', () => ({ loadConfigFromDisk: () => ({}), updateConfig: vi.fn() }));
vi.mock('../../main/chat-ipc.ts', () => ({ resolveApiKey: () => '' }));
vi.mock('../../main/providers/registry.ts', () => ({ resolveProvider: vi.fn() }));
vi.mock('../../main/paths.ts', () => ({ getAppPaths: () => ({ appData: host.appData }) }));
vi.mock('../../main/agente/llm/stream-fn.ts', () => ({ createProviderStreamFn: () => host.stream }));
vi.mock('../../main/agente/tools/builtins.ts', () => ({ createBuiltinTools: () => host.tools }));
vi.mock('../../main/agente/extensions/builtin.ts', () => ({ createBuiltinExtensions: () => host.extensions }));
vi.mock('../../main/agente/event-bridge.ts', () => ({ emitCodeAgentEvent: host.emit }));

import { abort, disposeAllSessions, listCheckpoints, prompt, respondApproval, rollback, startSession } from '../../main/agente/runtime.ts';
import { CheckpointStore } from '../../main/agente/tools/checkpoint.ts';

const chatId = 'runtime-test';
let root: string;
let events: CodeAgentEvent[];
let execute: ReturnType<typeof vi.fn<AgentTool['execute']>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function toolMessage(content = 'changed'): AssistantMessage {
  return {
    role: 'assistant', content: '', stopReason: 'toolUse', ts: Date.now(),
    toolCalls: [{ id: 'write-call', name: 'write', arguments: { path: 'sample.txt', content } }]
  };
}

async function start(mode: AgenteRuntimeMode = 'supervised', resumeSessionId?: string, checkpointsEnabled = false) {
  return startSession({ chatId, projectRoot: root, provider: 'local', model: 'test', runtimeMode: mode, resumeSessionId, checkpointsEnabled });
}

async function waitForEnd(count = 1) {
  await vi.waitFor(() => expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(count));
}

beforeEach(async () => {
  host.appData = await fsp.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'agente-runtime-'));
  root = path.join(host.appData, 'project');
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(root, 'sample.txt'), 'original');
  events = [];
  host.emit.mockReset().mockImplementation((_sender, event) => { events.push(event); });
  host.stream.mockReset().mockResolvedValue(toolMessage());
  host.extensions = [];
  execute = vi.fn(async (_id, args) => {
    await fsp.writeFile(path.join(root, String(args.path)), String(args.content));
    return { content: 'written', terminate: true };
  });
  host.tools = [{ name: 'write', description: 'test writer', parameters: {}, mutating: true, executionMode: 'sequential', execute }];
});

afterEach(async () => {
  disposeAllSessions();
  // Let canceled fire-and-forget runs finish before removing their transcript directory.
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  await fsp.rm(host.appData, { recursive: true, force: true });
});

describe('runtime approval preflight (real Agent and extension runner)', () => {
  it.each(['supervised', 'plan'] as const)('registers an immediate %s approval response before emission', async (mode) => {
    const responses: Array<{ ok: boolean }> = [];
    host.emit.mockImplementation((_sender, event) => {
      events.push(event);
      if (event.type === 'approval_request') responses.push(respondApproval(chatId, event.requestId, 'allow'));
    });
    await start(mode);
    await prompt(chatId, 'write');
    await vi.waitFor(() => expect(responses).toEqual([{ ok: true }]));
    await waitForEnd();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'approval_resolved')).toHaveLength(1);
  });

  it.each(['supervised', 'plan'] as const)('abort resolves a pending %s approval once and never executes', async (mode) => {
    await start(mode);
    await prompt(chatId, 'write');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval_request')).toBe(true));
    const request = events.find((event) => event.type === 'approval_request')!;
    expect(abort(chatId)).toEqual({ ok: true });
    expect(abort(chatId)).toEqual({ ok: true });
    await waitForEnd();
    expect(events.filter((event) => event.type === 'approval_resolved')).toEqual([
      expect.objectContaining({ requestId: request.requestId, decision: 'deny' })
    ]);
    expect(respondApproval(chatId, request.requestId, 'allow')).toEqual({ ok: false });
    expect(execute).not.toHaveBeenCalled();
    expect(await fsp.readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('original');
    expect(events).toContainEqual({ type: 'agent_end', chatId, stopReason: 'aborted' });
  });

  it.each(['abort', 'dispose'] as const)('%s during an awaited tool hook creates no late approval or execution', async (operation) => {
    const entered = deferred();
    const release = deferred();
    host.extensions = [{ id: 'delayed', name: 'delayed', description: '', setup(api) {
      api.on('tool_call', async () => { entered.resolve(); await release.promise; });
    } }];
    await start('plan');
    await prompt(chatId, 'write');
    await entered.promise;
    if (operation === 'abort') abort(chatId);
    else disposeAllSessions();
    release.resolve();
    await waitForEnd();
    expect(events.some((event) => event.type === 'approval_request')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('abort during async diff preparation cannot emit a late approval', async () => {
    const message = toolMessage();
    message.toolCalls![0]!.arguments.content = { toString() { abort(chatId); return 'changed'; } };
    host.stream.mockResolvedValue(message);
    await start();
    await prompt(chatId, 'write');
    await waitForEnd();
    expect(events.some((event) => event.type === 'approval_request')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('abort while checkpoint capture is awaited prevents execution after capture', async () => {
    const entered = deferred();
    const release = deferred();
    vi.spyOn(CheckpointStore.prototype, 'capture').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    await start('full', undefined, true);
    await prompt(chatId, 'write');
    await entered.promise;
    abort(chatId);
    release.resolve();
    await waitForEnd();
    expect(execute).not.toHaveBeenCalled();
  });

  it('abort before the tool gate also blocks nonmutating tools', async () => {
    host.tools[0]!.mutating = false;
    host.stream.mockImplementation(async () => { abort(chatId); return toolMessage(); });
    await start('full');
    await prompt(chatId, 'write');
    await waitForEnd();
    expect(execute).not.toHaveBeenCalled();
  });

  it('abort during before_agent_start prevents a delayed run from starting', async () => {
    const entered = deferred();
    const release = deferred();
    host.extensions = [{ id: 'startup', name: 'startup', description: '', setup(api) {
      api.on('before_agent_start', async () => { entered.resolve(); await release.promise; });
    } }];
    await start('full');
    const pending = prompt(chatId, 'write');
    await entered.promise;
    abort(chatId);
    release.resolve();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.stream).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('runtime checkpoint numbering (real disk stores)', () => {
  it('preserves distinct preimages across two prompts and resumes above the existing maximum', async () => {
    const { sessionId } = await start('full', undefined, true);
    for (const [index, content] of ['first', 'second'].entries()) {
      host.stream.mockResolvedValue(toolMessage(content));
      await prompt(chatId, content);
      await waitForEnd(index + 1);
      await vi.waitFor(() => expect(events.filter((event) => event.type === 'checkpoint_finalized')).toHaveLength(index + 1));
    }
    expect((await listCheckpoints(chatId)).map((turn) => turn.turnIndex)).toEqual([1, 2]);
    const checkpointRoot = path.join(host.appData, 'agente', 'checkpoints', sessionId);
    expect(await fsp.readFile(path.join(checkpointRoot, '1/before/sample.txt'), 'utf8')).toBe('original');
    expect(await fsp.readFile(path.join(checkpointRoot, '2/before/sample.txt'), 'utf8')).toBe('first');

    disposeAllSessions();
    // Include an unfinished checkpoint: numbering must use listTurns, not only finalized stats.
    await fsp.mkdir(path.join(checkpointRoot, '7/before'), { recursive: true });
    expect(await start('full', sessionId, true)).toEqual({ sessionId, resumed: true });
    host.stream.mockResolvedValue(toolMessage('third'));
    await prompt(chatId, 'third');
    await waitForEnd(3);
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'checkpoint_finalized')).toHaveLength(3));
    expect(events.filter((event) => event.type === 'checkpoint_captured').map((event) => event.turnIndex)).toEqual([1, 2, 8]);
    expect(events.filter((event) => event.type === 'checkpoint_finalized').map((event) => event.turnIndex)).toEqual([1, 2, 8]);
    expect((await listCheckpoints(chatId)).map((turn) => turn.turnIndex)).toEqual([1, 2, 7, 8]);
    expect(await rollback(chatId, 8)).toEqual({ ok: true, restored: 1 });
    expect(await fsp.readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('second');
    expect(await rollback(chatId, 2)).toEqual({ ok: true, restored: 1 });
    expect(await fsp.readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('first');
    expect(await rollback(chatId, 1)).toEqual({ ok: true, restored: 1 });
    expect(await fsp.readFile(path.join(root, 'sample.txt'), 'utf8')).toBe('original');
  });
});
