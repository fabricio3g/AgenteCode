/** Home owns its renderer tools; Rust owns the complete model conversation. */
import crypto from 'node:crypto';
import type { IpcMain, WebContents } from 'electron';
import { runtimeConnection, useProvider, modelSeesImages } from './rust-engine.ts';
import { createComputerTools } from './tools/computer.ts';
import { bindComputerOwner, cancelComputerTurn, settleComputerTurn, computerSession, type ComputerOwner } from '../computer/desktop.ts';
import { COMPUTER_INSTRUCTIONS } from '../../shared/computer.ts';
import type { AgentTool } from '../../shared/agent-core/types.ts';
import type { Attachment } from '../../shared/agente-protocol.gen.ts';
import { notifyActivity } from '../notifications.ts';
import { trackGoalTurn, goalTurnStarted } from '../session-goals.ts';
import type { AgenteClient } from '../agente-client.ts';
import type { ClientToolCall, RuntimeEventEnvelope, SessionSnapshot, TurnOutcome } from '../../shared/agente-protocol.gen.ts';
import type { HomeRuntimeEvent, HomeStartArgs, HomeToolReply } from '../../shared/home-runtime.ts';
import { homeComplements } from './complements.ts';
import { parseComplementTool } from '../../shared/complements.ts';

type Run = { runId: string; sessionId: string; turnId?: string; owner: WebContents; client: AgenteClient; pending: Set<string>; approvals: Set<string>; complementNames?: Map<string, string>; cancelled?: boolean; dispose?: () => void; chatId?: string; computerTools?: Map<string, AgentTool>; computerCalls?: Map<string, AbortController> };
const runs = new Map<string, Run>();
function release(run: Run) {
  if (runs.get(run.runId) !== run) return;
  runs.delete(run.runId);
  if (run.turnId) settleComputerTurn(run.sessionId, run.turnId);
  for (const call of run.computerCalls?.values() ?? []) call.abort();
  run.dispose?.();
}
let subscribed: AgenteClient | null = null;
function send(run: Run, event: HomeRuntimeEvent) {
  if (!run.owner.isDestroyed()) run.owner.send('home_runtime_event', event);
}
async function cancel(run: Run) {
  run.cancelled = true;
  cancelComputerTurn(run.sessionId);
  for (const call of run.computerCalls?.values() ?? []) call.abort();
  for (const requestId of run.pending) {
    send(run, { runId: run.runId, type: 'cancel', call: { session_id: run.sessionId, turn_id: run.turnId || '', request_id: requestId, call_id: requestId, name: '', arguments: {} } });
  }
  if (run.turnId) await run.client.request('turn.cancel', { turn_id: run.turnId }).catch(() => {});
}
function computerOwner(run: Run): ComputerOwner | undefined {
  if (!run.chatId || !run.turnId || run.owner.isDestroyed()) return undefined;
  return { sessionId: run.sessionId, turnId: run.turnId, chatId: run.chatId, space: 'home', webContentsId: run.owner.id,
    stop: () => { void cancel(run); },
    resume: () => { if (!run.owner.isDestroyed()) run.owner.send('computer_resume', { chatId: run.chatId, space: 'home' }); },
  };
}
async function executeComputerCall(run: Run, call: ClientToolCall) {
  const controller = new AbortController();
  run.computerCalls ??= new Map(); run.computerCalls.set(call.request_id, controller);
  let content = ''; let isError = false; const attachments: Attachment[] = [];
  try {
    const result = await run.computerTools!.get(call.name)!.execute(call.call_id, call.arguments as Record<string, unknown>, { sessionId: run.sessionId, signal: controller.signal });
    content = result.content; isError = !!result.isError;
    for (const image of result.images ?? []) {
      const imported = await run.client.request<{ attachment: Attachment }>('media.import', { name: 'computer-observation.jpg', data: image.data });
      attachments.push(imported.attachment);
    }
  } catch (error) { content = error instanceof Error ? error.message : String(error); isError = true; }
  finally { run.computerCalls.delete(call.request_id); }
  if (runs.get(run.runId) !== run || !run.pending.delete(call.request_id)) return;
  await run.client.request('client_tools.result', { session_id: call.session_id, turn_id: call.turn_id, request_id: call.request_id, content, is_error: isError, attachments }).catch(() => {});
}
function connectNotifications(client: AgenteClient) {
  if (subscribed === client) return;
  subscribed = client;
  client.onClose(() => {
    for (const run of runs.values()) if (run.client === client) {
      send(run, { runId: run.runId, type: 'error', message: 'The Rust runtime disconnected. Send your request again to reconnect.' });
      release(run);
    }
  });
  client.onNotification((method, params) => {
    if (method === 'client_tools.call' || method === 'client_tools.cancel') {
      const call = params as ClientToolCall;
      const run = [...runs.values()].find((run) => run.sessionId === call.session_id && (!run.turnId || run.turnId === call.turn_id));
      if (!run) return;
      run.turnId = call.turn_id;
      if (method === 'client_tools.call') run.pending.add(call.request_id);
      else { run.pending.delete(call.request_id); run.computerCalls?.get(call.request_id)?.abort(); }
      if (run.computerTools?.has(call.name)) { if (method === 'client_tools.call') void executeComputerCall(run, call); return; }
      send(run, { runId: run.runId, type: method === 'client_tools.call' ? 'call' : 'cancel', call });
    } else if (method === 'event') {
      const envelope = params as RuntimeEventEnvelope;
      const run = [...runs.values()].find((run) => run.sessionId === envelope.session_id && (!run.turnId || run.turnId === envelope.turn_id));
      if (!run) return;
      run.turnId = envelope.turn_id;
      const event = envelope.event;
      if (event.type === 'approval_requested') run.approvals.add(event.request_id);
      const toolName = event.type === 'approval_requested' ? event.tool_name : event.type === 'tool_proposed' ? event.name : '';
      const complement = parseComplementTool(toolName);
      send(run, { runId: run.runId, type: 'event', envelope, serviceName: complement && run.complementNames?.get(complement.id) });
    } else if (method === 'turn.outcome') {
      const outcome = params as TurnOutcome;
      const run = [...runs.values()].find((run) => run.sessionId === outcome.session_id && run.turnId === outcome.turn_id);
      if (!run) return;
      if (run.chatId && outcome.status !== 'cancelled') notifyActivity({ id: `home-${outcome.turn_id}`, chatId: run.chatId, space: 'home', title: outcome.status === 'completed' ? 'Task finished' : 'Task failed', body: outcome.status === 'completed' ? 'Your result is ready.' : 'Open the chat to review the error.' }, run.owner);
      void client.request<{ snapshot: SessionSnapshot }>('session.get', { session_id: run.sessionId }).then(({ snapshot }) => {
        send(run, { runId: run.runId, type: 'outcome', outcome, snapshot });
      }).catch((error: unknown) => send(run, { runId: run.runId, type: 'error', message: String(error) })).finally(() => release(run));
    }
  });
}
export function registerHomeRuntimeHandlers(ipcMain: IpcMain) {
  ipcMain.handle('home_runtime_start', async (event, args: HomeStartArgs) => {
    const client = await runtimeConnection();
    const hello = await client.request<{ capabilities?: string[] }>('initialize', { client: 'agente-home' });
    if (!hello.capabilities?.includes('home_turns_v1')) throw new Error('Home requires an updated Rust runtime. Update Agente and restart the running daemon.');
    connectNotifications(client);
    if (runs.has(args.runId)) throw new Error('This Home turn is already running.');
    let sessionId = args.sessionId || crypto.randomUUID();
    if (args.forkIndex !== undefined && args.sessionId) {
      const snapshot = await client.request<SessionSnapshot>('session.fork', { session_id: sessionId, conversation_index: args.forkIndex });
      sessionId = snapshot.session_id;
    }
    if ([...runs.values()].some((run) => run.sessionId === sessionId)) throw new Error('This Home chat is already working.');
    const provider = await useProvider(client, args.provider, args.model, args.localSelection);
    trackGoalTurn(sessionId, client, event.sender, provider.id, provider.model, args.prompt?.content);
    const info = await client.request<{ limits?: { context?: number } }>('models.info', { provider: provider.id, model: provider.model });
    const run: Run = { runId: args.runId, sessionId, owner: event.sender, client, pending: new Set(), approvals: new Set(), chatId: args.chatId };
    if (args.policy.complements && args.chatId && args.policy.max_tool_calls > 0 && hello.capabilities.includes('complements_v1')) {
      run.complementNames = await homeComplements(client).catch(() => undefined);
    }
    const computerEnabled = args.computerEnabled && !!args.chatId && await modelSeesImages(args.provider, args.model);
    if (computerEnabled) run.computerTools = new Map(createComputerTools({ owner: () => computerOwner(run), canSeeImages: () => true }).map(tool => [tool.name, tool]));
    const computerDefinitions = [...(run.computerTools?.values() ?? [])].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sequential: true, mutating: true }));
    await client.request('client_tools.register', { session_id: sessionId, tools: [...args.tools.filter(tool => !tool.name.startsWith('computer_')), ...computerDefinitions] });
    runs.set(args.runId, run);
    const disconnect = () => { computerSession.releaseOwner(event.sender.id); void cancel(run); };
    event.sender.once('destroyed', disconnect);
    event.sender.once('render-process-gone', disconnect);
    run.dispose = () => {
      event.sender.removeListener('destroyed', disconnect);
      event.sender.removeListener('render-process-gone', disconnect);
    };
    try {
      const result = await client.request<{ turn_id: string; conversation_index?: number }>('turn.start', {
        session_id: sessionId, conversation: args.conversation || [], prompt: args.prompt,
        system_prompt: args.systemPrompt + (computerEnabled ? `\n\n${COMPUTER_INSTRUCTIONS}` : ''), provider: provider.id, model: provider.model,
        thinking_level: args.thinkingLevel || 'auto', home: { ...args.policy, complements: !!run.complementNames?.size }, mode: 'auto',
        origin: { channel: 'desktop-home', trust: 'owner' }
      });
      run.turnId = result.turn_id;
      if (run.cancelled) await cancel(run);
      goalTurnStarted(sessionId,result.turn_id);
      const owner = computerOwner(run); if (owner) bindComputerOwner(owner);
      return { sessionId, turnId: result.turn_id, conversationIndex: result.conversation_index, contextWindow: info.limits?.context || 32_768 };
    } catch (error) { release(run); throw error; }
  });
  ipcMain.handle('home_runtime_approval', async (event, args: { runId: string; requestId: string; allow: boolean }) => {
    const run = runs.get(args.runId);
    if (!run || run.owner.id !== event.sender.id || !run.approvals.delete(args.requestId)) return { ok: false };
    return run.client.request('approval.respond', { request_id: args.requestId, decision: args.allow === true ? 'approve_once' : 'deny' });
  });
  ipcMain.handle('home_runtime_result', async (event, args: HomeToolReply) => {
    const run = runs.get(args.runId);
    if (!run || run.owner.id !== event.sender.id || run.sessionId !== args.result.session_id || run.turnId !== args.result.turn_id || !run.pending.delete(args.result.request_id)) throw new Error('Stale or foreign Home tool result.');
    return run.client.request('client_tools.result', args.result);
  });
  ipcMain.handle('home_runtime_update', async (event, args: { sessionId: string; thinkingLevel?: string }) => {
    const run = [...runs.values()].find(run => run.sessionId === args.sessionId && run.owner.id === event.sender.id);
    if (!run?.turnId) return { ok: false };
    return run.client.request('turn.update', { turn_id: run.turnId, thinking_level: args.thinkingLevel || 'auto' });
  });
  ipcMain.handle('home_runtime_steer', async (event, args: { sessionId: string; content: string }) => {
    const run = [...runs.values()].find(run => run.sessionId === args.sessionId && run.owner.id === event.sender.id);
    if (!run?.turnId || !args.content?.trim()) return { ok: false };
    return run.client.request('turn.steer', { turn_id: run.turnId, content: args.content.trim(), attachments: [] });
  });
  ipcMain.handle('home_runtime_cancel', async (event, args: { runId: string }) => {
    const run = runs.get(args.runId);
    if (run && run.owner.id === event.sender.id) await cancel(run);
  });
}
