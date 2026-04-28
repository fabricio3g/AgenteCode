export interface SandboxTerminalEntry {
  id: string;
  cmd: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  timedOut?: boolean;
  timestamp: number;
}

class SandboxStore {
  terminalOutput = $state<SandboxTerminalEntry[]>([]);

  addEntry(entry: Omit<SandboxTerminalEntry, 'id' | 'timestamp'>) {
    const id = `agent-term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.terminalOutput = [
      ...this.terminalOutput,
      { ...entry, id, timestamp: Date.now() }
    ];
  }

  clear() {
    this.terminalOutput = [];
  }
}

export const sandboxStore = new SandboxStore();
