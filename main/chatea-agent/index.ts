export { detectChateaAgent, startChateaAgentSession, sendCommand, closeChateaAgentSession, disposeAllChateaAgentSessions } from './harness.ts';
export { getSession, setSession, removeSession, hasSession, disposeSession, disposeAllSessions, listActiveSessions } from './session-pool.ts';
export { emitCodeAgentEvent, setMainWindowGetter } from './event-bridge.ts';
export type * from './types.ts';
