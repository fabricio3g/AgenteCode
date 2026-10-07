// Side panel ⇄ background. The chat bodies are the bridge's chat protocol,
// passed through untouched; the rest is the panel asking about the socket.

import type { ChatEvent, ChatRequest, PageContext } from '../../../shared/browser/chat-protocol';

export interface BridgeStatus {
  state: 'unpaired' | 'connecting' | 'connected' | 'offline' | 'refused';
  /** Agente Desktop is attached and will answer chat. */
  app: boolean;
  error?: string;
}

export type PanelIn =
  | { kind: 'hello' }
  | { kind: 'pair'; code: string }
  | { kind: 'unpair' }
  | { kind: 'chat'; id: string; body: ChatRequest }
  | { kind: 'page' };

export type PanelOut =
  | { kind: 'status'; status: BridgeStatus }
  | { kind: 'chat'; id: string; body: ChatEvent }
  | { kind: 'page'; page: PageContext | null };
