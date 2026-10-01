// ── Rust runtime events → Code section events ──────────────────────────
// The Code UI was built on the TypeScript engine's CodeAgentEvent stream.
// When the Rust runtime drives a chat, this translator turns its protocol
// events into that same stream, so nothing in the renderer changes: tool
// names and arguments are mapped to the ones the UI knows, a tool's file
// changes ride its tool_end, and each finished turn reports what it changed.

import { structuredPatch } from 'diff';
import type { RuntimeEvent, RuntimeEventEnvelope } from '../../shared/agente-protocol.gen.ts';
import type { CodeAgentEvent, CodeTodoItem } from '../../shared/agente-protocol.ts';
import { lineCount } from './text-lines.ts';

/** Rust tool name → the name the Code UI renders (commands, edits, reads…). */
const UI_TOOL_NAMES: Record<string, string> = {
  shell: 'bash',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  apply_patch: 'edit',
  list_dir: 'ls',
  file_outline: 'outline',
  todo_write: 'todo'
};

/** Desktop's own tools come back through MCP as desktop_<name>. */
const DESKTOP_TOOL_PREFIX = 'desktop_';

export function uiToolName(name: string): string {
  if (name.startsWith(DESKTOP_TOOL_PREFIX)) return name.slice(DESKTOP_TOOL_PREFIX.length);
  return UI_TOOL_NAMES[name] ?? name;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Rough +/− line counts: lines only in `after` / only in `before`. */
export function diffStats(before: string | null | undefined, after: string | null | undefined): { additions: number; deletions: number } {
  if (before == null) return { additions: lineCount(after), deletions: 0 };
  if (after == null) return { additions: 0, deletions: lineCount(before) };
  const unmatched = lineCounts(before);
  let additions = 0;
  for (const line of after.split('\n')) {
    const left = unmatched.get(line) ?? 0;
    if (left > 0) unmatched.set(line, left - 1);
    else additions += 1;
  }
  const deletions = [...unmatched.values()].reduce((sum, left) => sum + left, 0);
  return { additions, deletions };
}

function changeKind(before: string | null | undefined, after: string | null | undefined): string {
  if (before == null) return 'added';
  if (after == null) return 'deleted';
  return 'modified';
}

/** Longest patch a step carries into the transcript (it is saved with the chat). */
const MAX_PATCH_CHARS = 24_000;

/**
 * A real unified diff — hunks with three lines of context — for the edit's
 * card and the approval card. Only what changed travels, never whole files.
 */
function unifiedPatch(path: string | null | undefined, before: string | null | undefined, after: string | null | undefined): string | undefined {
  if (before == null && after == null) return undefined;
  const name = path ?? '';
  const patch = structuredPatch(name, name, before ?? '', after ?? '', '', '', { context: 3 });
  const lines = [`--- ${name}`, `+++ ${name}`];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunk.lines.filter((line) => !line.startsWith('\\')));
  }
  const text = lines.join('\n');
  return text.length > MAX_PATCH_CHARS ? `${text.slice(0, MAX_PATCH_CHARS)}\n…` : text;
}

/** The approval card's preview: the same unified diff. */
export const approvalDiff = unifiedPatch;

function todos(value: unknown): CodeTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = (item ?? {}) as { content?: unknown; status?: unknown };
    const status = String(record.status ?? 'pending');
    return {
      content: String(record.content ?? ''),
      status: status === 'in_progress' || status === 'completed' ? status : 'pending'
    };
  });
}

type FileChange = { path: string; kind: string; additions: number; deletions: number; patch?: string };

/**
 * One chat's translator. Stateful per turn: tool output accumulates for
 * tool_update, a tool_end waits for the file changes the runtime reports
 * right after it, and the turn's changed files close the turn.
 */
export class RustTurnTranslator {
  private turnIndex = 0;
  private readonly output = new Map<string, string>();
  private pendingEnd: Extract<CodeAgentEvent, { type: 'tool_end' }> | null = null;
  private turnFiles = new Map<string, FileChange>();

  constructor(
    private readonly chatId: string,
    private readonly contextWindow: () => number
  ) {}

  translate(envelope: RuntimeEventEnvelope): CodeAgentEvent[] {
    // A subagent's own events are not this chat's steps.
    if (envelope.parent_run_id && envelope.event.type !== 'approval_requested') return [this.runtimeEvent(envelope.event, envelope.parent_run_id)];
    const event = envelope.event;
    if (event.type === 'file_changed') {
      this.recordFile(event);
      return [];
    }
    const out = this.flushPendingEnd();
    out.push(...this.map(event));
    return out;
  }

  private flushPendingEnd(): CodeAgentEvent[] {
    if (!this.pendingEnd) return [];
    const end = this.pendingEnd;
    this.pendingEnd = null;
    return [end];
  }

  private recordFile(event: Extract<RuntimeEvent, { type: 'file_changed' }>): void {
    const stats = diffStats(event.before, event.after);
    const change = { path: event.path, kind: changeKind(event.before, event.after), ...stats };
    const previous = this.turnFiles.get(event.path);
    this.turnFiles.set(event.path, previous ? { ...change, additions: previous.additions + stats.additions, deletions: previous.deletions + stats.deletions } : change);
    if (this.pendingEnd) {
      const patch = unifiedPatch(event.path, event.before, event.after);
      this.pendingEnd.fileChanges = [...(this.pendingEnd.fileChanges ?? []), { path: change.path, kind: change.kind }];
      this.pendingEnd.diffStats = [...(this.pendingEnd.diffStats ?? []), { ...change, ...(patch ? { patch } : {}) }];
    }
  }

  private finishTurn(stopReason: 'stop' | 'aborted' | 'error'): CodeAgentEvent[] {
    const out: CodeAgentEvent[] = [];
    const files = [...this.turnFiles.values()];
    if (files.length) {
      out.push({ type: 'checkpoint_finalized', chatId: this.chatId, turnIndex: this.turnIndex, files });
    }
    this.turnFiles = new Map();
    this.output.clear();
    out.push({ type: 'turn_end', chatId: this.chatId, turnIndex: this.turnIndex });
    out.push({ type: 'agent_end', chatId: this.chatId, stopReason });
    return out;
  }

  private map(event: RuntimeEvent): CodeAgentEvent[] {
    const handler = this.handlers[event.type] as ((event: RuntimeEvent) => CodeAgentEvent[]) | undefined;
    return handler ? handler(event) : [this.runtimeEvent(event)];
  }

  private runtimeEvent(event: RuntimeEvent, parentRunId?: string): CodeAgentEvent {
    return { type: 'runtime_event', chatId: this.chatId, event, ...(parentRunId ? { parentRunId } : {}) };
  }

  private usage(usage: Extract<RuntimeEvent, { type: 'usage' }>['usage']): CodeAgentEvent {
    const prompt = usage.context_tokens || usage.prompt_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
    return {
      type: 'usage',
      chatId: this.chatId,
      promptTokens: prompt,
      completionTokens: usage.completion_tokens,
      totalTokens: prompt + usage.completion_tokens,
      contextWindow: this.contextWindow()
    };
  }

  private readonly handlers: { [K in RuntimeEvent['type']]?: (event: Extract<RuntimeEvent, { type: K }>) => CodeAgentEvent[] } = {
    turn_started: () => {
      this.turnIndex += 1;
      return [
        { type: 'agent_start', chatId: this.chatId },
        { type: 'turn_start', chatId: this.chatId, turnIndex: this.turnIndex }
      ];
    },
    assistant_delta: (event) => [{ type: 'text_delta', chatId: this.chatId, delta: event.text }],
    reasoning_delta: (event) => [{ type: 'thinking_delta', chatId: this.chatId, delta: event.text }],
    // The tool being written ("Preparing edit…") in the names the UI knows.
    generation_progress: (event) => [this.runtimeEvent({ ...event, tool_name: event.tool_name ? uiToolName(event.tool_name) : event.tool_name })],
    tool_proposed: (event) => {
      this.output.set(event.id, '');
      return [{ type: 'tool_start', chatId: this.chatId, toolCallId: event.id, toolName: uiToolName(event.name), args: parseArgs(event.arguments) }];
    },
    tool_progress: (event) => {
      const text = ((this.output.get(event.id) ?? '') + event.chunk).slice(-32_768);
      this.output.set(event.id, text);
      return [{ type: 'tool_update', chatId: this.chatId, toolCallId: event.id, partialResult: text }];
    },
    tool_result: (event) => {
      this.output.delete(event.id);
      this.pendingEnd = {
        type: 'tool_end',
        chatId: this.chatId,
        toolCallId: event.id,
        result: event.content,
        isError: event.is_error,
        status: event.is_error ? 'error' : 'done'
      };
      return [];
    },
    approval_requested: (event) => [{
      type: 'approval_request',
      chatId: this.chatId,
      requestId: event.request_id,
      toolName: uiToolName(event.tool_name),
      args: parseArgs(event.tool_args),
      diff: approvalDiff(event.file_path, event.old_content, event.new_content) ?? event.description,
      kind: 'action'
    }],
    todo_changed: (event) => [{ type: 'todo_update', chatId: this.chatId, todos: todos(event.todos) }],
    compaction_started: () => [{ type: 'compaction_start', chatId: this.chatId, reason: 'auto' }],
    context_compacted: (event) => [{ type: 'compaction_end', chatId: this.chatId, reason: 'auto', success: true, tokensBefore: event.tokens_before, tokensAfter: event.tokens_after, smart: event.smart }],
    usage: (event) => [this.usage(event.usage)],
    retry: (event) => [{ type: 'llm_retry', chatId: this.chatId, attempt: event.attempt, delayMs: event.delay_ms }],
    turn_finished: () => this.finishTurn('stop'),
    turn_cancelled: () => this.finishTurn('aborted'),
    turn_failed: (event) => [{ type: 'error', chatId: this.chatId, message: event.message }, ...this.finishTurn('error')]
  };
}
