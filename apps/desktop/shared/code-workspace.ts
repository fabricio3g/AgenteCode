// Types shared by main and the renderer for the Code space panes:
// background processes, the integrated terminal and the Changes pane.

export type ProcessStatus = 'running' | 'exited' | 'stopped';

export interface ProcessInfo {
  id: string;
  chatId: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Local URLs seen in the output, first one first. */
  urls: string[];
}

export type ProcessEvent =
  | { type: 'process_start'; process: ProcessInfo }
  | { type: 'process_output'; id: string; chatId: string; chunk: string }
  | { type: 'process_exit'; process: ProcessInfo }
  | { type: 'process_url'; process: ProcessInfo; url: string };

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number };

export type ChangeKind = 'created' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
}

export interface ChangeList {
  source: 'git' | 'checkpoints' | 'none';
  branch?: string;
  files: ChangedFile[];
}

export interface FileDiff {
  path: string;
  before: string;
  after: string;
  binary: boolean;
  tooLarge: boolean;
}
