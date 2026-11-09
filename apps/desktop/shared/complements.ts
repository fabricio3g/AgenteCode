export type ComplementTransport = 'http' | 'stdio';
export type ComplementStatus = 'disabled' | 'connecting' | 'connected' | 'failed' | 'unavailable';

export interface ComplementSettings {
  name: string;
  transport: ComplementTransport;
  target: string;
  args: string[];
}

export interface Complement extends ComplementSettings {
  id: string;
  enabled: boolean;
  hasCredentials: boolean;
  status: ComplementStatus;
  tools: number;
  toolNames: string[];
}

export type ComplementChange =
  | { action: 'save'; id?: string; settings: ComplementSettings; credentials?: Record<string, string> }
  | { action: 'enable'; id: string; enabled: boolean }
  | { action: 'retry' | 'remove'; id: string };

export function parseComplementTool(name: string) {
  const parts = /^complement_([a-f0-9]{12})_(.+)$/.exec(name);
  return parts ? { id: parts[1], label: parts[2].replaceAll('_', ' ') } : undefined;
}
