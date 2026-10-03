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

/** One local branch, as `git for-each-ref` describes it. */
export interface GitBranch {
  name: string;
  /** Short commit id of the branch tip. */
  commit: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

/** Everything the branch menu needs for one project, in a single round trip. */
export interface GitBranches {
  source: 'git' | 'none';
  /** The branch HEAD points at, the short commit when detached, null outside git. */
  current: string | null;
  detached: boolean;
  /** The worktree has staged, modified or deleted files (untracked ones do not count). */
  dirty: boolean;
  branches: GitBranch[];
}

/** `git switch` is an action, so failure comes back as data, never as a throw. */
export interface SwitchBranchResult {
  ok: boolean;
  error?: string;
  branch?: string;
}

export interface OpenInEditorArgs {
  projectRoot: string;
  /** Project-relative or absolute; the main process rejects paths outside the root. */
  path: string;
  line?: number;
  /** The user's editor preference; empty means resolve from the environment. */
  editor?: string;
}

/**
 * A terminal-only editor (nvim, vim, hx) cannot be launched detached into a
 * window; the app runs it in its own terminal instead. `command` is a complete
 * shell line, already quoted.
 */
export interface EditorTerminalRequest {
  command: string;
  cwd: string;
}

/** `ok: false` carries a message; a `terminal` request means "run this instead". */
export interface OpenInEditorResult {
  ok: boolean;
  /** The editor that was launched (or would have been), for the toast. */
  editor?: string;
  error?: string;
  terminal?: EditorTerminalRequest;
}
