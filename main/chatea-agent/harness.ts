import type { ChateaAgentStartSessionArgs, ChateaAgentStartSessionResult, ChateaAgentDetectArgs, ChateaAgentDetectResult } from './types.ts';
import { setSession } from './session-pool.ts';

export async function detectChateaAgent(args: ChateaAgentDetectArgs): Promise<ChateaAgentDetectResult> {
  // Stub: always ready. Commit 2 will check provider config + model availability.
  void args;
  return { status: 'ready' };
}

export async function startChateaAgentSession(args: ChateaAgentStartSessionArgs): Promise<ChateaAgentStartSessionResult> {
  // Stub: generate a session id. Commit 2 will create the real agent loop.
  const sessionId = `chatea-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setSession(args.chatId, {
    chatId: args.chatId,
    sessionId,
    createdAt: Date.now(),
    disposed: false
  });
  return { sessionId };
}

export async function closeChateaAgentSession(chatId: string): Promise<void> {
  // Stub: commit 2 will dispose the real agent session.
  void chatId;
}

export async function disposeAllChateaAgentSessions(): Promise<void> {
  // Stub: commit 2 will dispose all real agent sessions.
}
