/** Home owns its renderer tools; Rust owns the complete model conversation. */
import crypto from 'node:crypto';
import type { IpcMain, WebContents } from 'electron';
import { runtimeConnection, useProvider } from './rust-engine.ts';
import type { AgenteClient } from '../agente-client.ts';
import type { ClientToolCall, RuntimeEventEnvelope, SessionSnapshot, TurnOutcome } from '../../shared/agente-protocol.gen.ts';
import type { HomeRuntimeEvent, HomeStartArgs, HomeToolReply } from '../../shared/home-runtime.ts';

type Run = { runId: string; sessionId: string; turnId?: string; owner: WebContents; client: AgenteClient; pending: Set<string> };
const runs = new Map<string, Run>();
let subscribed: AgenteClient | null = null;
function send(run: Run, event: HomeRuntimeEvent) {
  if (!run.owner.isDestroyed()) run.owner.send('home_runtime_event', event);
}
async function cancel(run: Run) {
  for (const requestId of run.pending) {
    send(run, { runId: run.runId, type: 'cancel', call: { session_id: run.sessionId, turn_id: run.turnId || '', request_id: requestId, call_id: requestId, name: '', arguments: {} } });
  }
  if (run.turnId) await run.client.request('turn.cancel', { turn_id: run.turnId }).catch(() => {});
}
function connectNotifications(client: AgenteClient) {
  if (subscribed === client) return;
  subscribed = client;
  client.onClose(() => {
    for (const run of runs.values()) if (run.client === client) {
      send(run, { runId: run.runId, type: 'error', message: 'The Rust runtime disconnected. Send your request again to reconnect.' });
      runs.delete(run.runId);
    }
  });
  client.onNotification((method, params) => {
    if (method === 'client_tools.call' || method === 'client_tools.cancel') {
      const call = params as ClientToolCall;
      const run = [...runs.values()].find((run) => run.sessionId === call.session_id && (!run.turnId || run.turnId === call.turn_id));
      if (!run) return;
      run.turnId = call.turn_id;
      if (method === 'client_tools.call') run.pending.add(call.request_id);
      else run.pending.delete(call.request_id);
      send(run, { runId: run.runId, type: method === 'client_tools.call' ? 'call' : 'cancel', call });
    } else if (method === 'event') {
      const envelope = params as RuntimeEventEnvelope;
      const run = [...runs.values()].find((run) => run.sessionId === envelope.session_id && (!run.turnId || run.turnId === envelope.turn_id));
      if (!run) return;
      run.turnId = envelope.turn_id;
      send(run, { runId: run.runId, type: 'event', envelope });
    } else if (method === 'turn.outcome') {
      const outcome = params as TurnOutcome;
      const run = [...runs.values()].find((run) => run.sessionId === outcome.session_id && run.turnId === outcome.turn_id);
      if (!run) return;
      void client.request<{ snapshot: SessionSnapshot }>('session.get', { session_id: run.sessionId }).then(({ snapshot }) => {
        send(run, { runId: run.runId, type: 'outcome', outcome, snapshot });
      }).catch((error: unknown) => send(run, { runId: run.runId, type: 'error', message: String(error) })).finally(() => runs.delete(run.runId));
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
    const provider = await useProvider(client, args.provider, args.model);
    const info = await client.request<{ limits?: { context?: number } }>('models.info', { provider: provider.id, model: provider.model });
    await client.request('client_tools.register', { session_id: sessionId, tools: args.tools });
    const run: Run = { runId: args.runId, sessionId, owner: event.sender, client, pending: new Set() };
    runs.set(args.runId, run);
    const disconnect = () => { void cancel(run); };
    event.sender.once('destroyed', disconnect);
    event.sender.once('render-process-gone', disconnect);
    try {
      const result = await client.request<{ turn_id: string; conversation_index?: number }>('turn.start', {
        session_id: sessionId, conversation: args.conversation || [], prompt: args.prompt,
        system_prompt: args.systemPrompt, provider: provider.id, model: provider.model,
        thinking_level: args.thinkingLevel || 'auto', home: args.policy, mode: 'auto',
        origin: { channel: 'desktop-home', trust: 'owner' }
      });
      run.turnId = result.turn_id;
      return { sessionId, turnId: result.turn_id, conversationIndex: result.conversation_index, contextWindow: info.limits?.context || 32_768 };
    } catch (error) { runs.delete(args.runId); throw error; }
    finally {
      // The owner listeners are removed when the turn settles, not when start returns.
      const remove = client.onNotification((method, params) => {
        if (method !== 'turn.outcome' || (params as TurnOutcome).turn_id !== run.turnId) return;
        event.sender.removeListener('destroyed', disconnect);
        event.sender.removeListener('render-process-gone', disconnect);
        remove();
      });
    }
  });
  ipcMain.handle('home_runtime_result', async (event, args: HomeToolReply) => {
    const run = runs.get(args.runId);
    if (!run || run.owner.id !== event.sender.id || run.sessionId !== args.result.session_id || run.turnId !== args.result.turn_id || !run.pending.delete(args.result.request_id)) throw new Error('Stale or foreign Home tool result.');
    return run.client.request('client_tools.result', args.result);
  });
  ipcMain.handle('home_runtime_cancel', async (event, args: { runId: string }) => {
    const run = runs.get(args.runId);
    if (run && run.owner.id === event.sender.id) await cancel(run);
  });
}
