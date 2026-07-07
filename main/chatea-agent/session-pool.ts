import type { ChateaAgentSessionEntry } from './types.ts';

const sessions = new Map<string, ChateaAgentSessionEntry>();

export function getSession(chatId: string): ChateaAgentSessionEntry | undefined {
  return sessions.get(chatId);
}

export function setSession(chatId: string, entry: ChateaAgentSessionEntry): void {
  sessions.set(chatId, entry);
}

export function removeSession(chatId: string): void {
  sessions.delete(chatId);
}

export function hasSession(chatId: string): boolean {
  return sessions.has(chatId);
}

export function disposeSession(chatId: string): void {
  const entry = sessions.get(chatId);
  if (entry) {
    entry.disposed = true;
    sessions.delete(chatId);
  }
}

export function disposeAllSessions(): void {
  for (const [, entry] of sessions) {
    entry.disposed = true;
  }
  sessions.clear();
}

export function listActiveSessions(): ChateaAgentSessionEntry[] {
  return Array.from(sessions.values()).filter((entry) => !entry.disposed);
}
