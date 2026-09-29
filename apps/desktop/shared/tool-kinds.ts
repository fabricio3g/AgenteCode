// What kind of work a tool does, by name. Mirrors `known_kind` in
// crates/agente-core/src/tools/mod.rs so the Desktop groups the Rust core's
// tools the way the TUI does. It also knows the short names main gives some
// of them for the UI (`uiToolName` in main/agente/rust-events.ts: shell →
// bash, read_file → read, list_dir → ls…) and the agent browser's tools.
// Unknown names (MCP tools) are "other".

export type ToolKind = 'read' | 'list' | 'search' | 'edit' | 'command' | 'web' | 'subagent' | 'other';

const KINDS: Record<string, ToolKind> = {
  read_file: 'read',
  file_outline: 'read',
  list_dir: 'list',
  process_list: 'read',
  process_output: 'read',
  skill: 'read',
  grep: 'search',
  find: 'search',
  write_file: 'edit',
  edit_file: 'edit',
  apply_patch: 'edit',
  shell: 'command',
  process_stop: 'command',
  web_search: 'web',
  web_fetch: 'web',
  task: 'subagent',
  task_output: 'subagent',
  kill_task: 'subagent',
  // UI names (uiToolName)
  bash: 'command',
  read: 'read',
  ls: 'list',
  outline: 'read',
  write: 'edit',
  edit: 'edit'
};

export function toolKind(name: string | undefined): ToolKind {
  if (!name) return 'other';
  return KINDS[name] ?? (name.startsWith('browser_') ? 'web' : 'other');
}
