// Agente run state: folds CodeAgentEvent pushes into AgentSteps + streamed
// content. Pure logic — no Svelte, no IPC — so it is directly testable.

import type { CodeAgentEvent, CodeArtifactRef, CodeRunSummary, CodeSourceRef, CodeStopReason, CodeTodoItem, AgentActivityKey } from '$shared/agente-protocol';
import type { AgentStep, CodeAgentDiffStat, CodeAgentFileChange, CodeTimelineEntry } from '$lib/types/chat';
import { sanitizeAgentVisibleText } from '$lib/services/agent-parsing';
import { copy } from '$lib/copy';

export interface AgenteUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
}

export interface CodeRunState {
  content: string;
  /** Text segments and steps in arrival order — what the transcript renders. */
  timeline: CodeTimelineEntry[];
  /** Wall-clock bounds of the run (agent_start → agent_end). */
  startedAt?: number;
  endedAt?: number;
  /** The turn budget ran out: the run stopped without finishing. */
  hitTurnLimit?: boolean;
  reasoning: string;
  /**
   * Raw reasoning accumulation. The display `reasoning` is re-sanitized from
   * this on every delta — exactly Home's rule (agent.ts), since the strip
   * patterns are multi-line and per-chunk sanitizing would miss splits.
   */
  reasoningRaw: string;
  steps: AgentStep[];
  diffStats: CodeAgentDiffStat[];
  fileChanges: CodeAgentFileChange[];
  usage?: AgenteUsage;
  error?: string;
  done: boolean;
  /** Why the run ended — drives the end-of-run status chip. */
  stopReason?: CodeStopReason;
  /** Where the current turn's output starts (see `rollBackTurn`). */
  turnMark?: { content: number; timeline: number; lastText: number; reasoning: number };
  /** Live retry notice (dsh llm/retry); cleared by the next content event. */
  retrying?: { attempt: number; delayMs: number } | null;
  /** The model-maintained todo list, updated live via todo_update. */
  todos: CodeTodoItem[];
  /** A length-truncated turn was auto-continued at least once this run. */
  truncatedOnce: boolean;
  /** Artifacts announced via artifact_created/list (references only). */
  artifacts: CodeArtifactRef[];
  /** Sources announced via sources/sources_delta. */
  sources: CodeSourceRef[];
  /** Canonical activity key from the activity event. */
  activity?: AgentActivityKey;
  /** End-of-run rollup from run_summary. */
  summary?: CodeRunSummary;
}

export function createCodeRunState(): CodeRunState {
  return { content: '', timeline: [], reasoning: '', reasoningRaw: '', steps: [], diffStats: [], fileChanges: [], done: false, todos: [], truncatedOnce: false, artifacts: [], sources: [] };
}

/** Add or update a step; a new step also takes its place in the timeline. */
function upsertStep(state: CodeRunState, step: AgentStep): void {
  const index = state.steps.findIndex((s) => s.id === step.id);
  if (index >= 0) {
    state.steps[index] = { ...state.steps[index], ...step };
    return;
  }
  state.steps.push(step);
  state.timeline.push({ kind: 'step', id: step.id });
}

/**
 * Streamed text joins the open text segment, or opens a new one after a
 * step. Segments are separated by a blank line in `content`, so the text of
 * consecutive turns never runs together ("…first.Done —").
 */
function lastTextLength(state: CodeRunState): number {
  const last = state.timeline[state.timeline.length - 1];
  return last?.kind === 'text' ? last.text.length : 0;
}

/** Drop what the current turn wrote: the model is replaying it. */
function rollBackTurn(state: CodeRunState): void {
  const mark = state.turnMark;
  if (!mark) return;
  state.content = state.content.slice(0, mark.content);
  state.timeline = state.timeline.slice(0, mark.timeline);
  const last = state.timeline[state.timeline.length - 1];
  if (last?.kind === 'text') last.text = last.text.slice(0, mark.lastText);
  state.reasoningRaw = state.reasoningRaw.slice(0, mark.reasoning);
  state.reasoning = sanitizeAgentVisibleText(state.reasoningRaw);
}

function appendText(state: CodeRunState, delta: string): void {
  const last = state.timeline[state.timeline.length - 1];
  if (last?.kind === 'text') {
    last.text += delta;
  } else {
    if (state.content && !state.content.endsWith('\n\n')) state.content += '\n\n';
    state.timeline.push({ kind: 'text', text: delta });
  }
  state.content += delta;
}

const TOOL_TYPES: Record<string, AgentStep['type']> = {
  read: 'reading',
  grep: 'reading',
  ls: 'reading',
  git_status: 'reading',
  git_diff: 'reading',
  write: 'writing',
  edit: 'writing',
  bash: 'executing'
};

/** The translated verb for a tool row ("Read", "Run"…), or its tidied name. */
function toolLabel(toolName: string): string {
  const verbs = copy.codeRun as Record<string, string>;
  if (Object.hasOwn(verbs, toolName)) return verbs[toolName]!;
  const words = toolName.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a tool call is about, in one short line: a path, a command, a search.
 * Replaces the raw JSON the rows used to show.
 */
function describeToolArgs(toolName: string, args: unknown): string {
  if (typeof args === 'string') return firstLine(args);
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  switch (toolName) {
    case 'read': {
      const offset = Number(record.offset) || 0;
      const limit = Number(record.limit) || 0;
      return offset || limit ? `${text('path')} · ${offset || 1}–${(offset || 1) + Math.max(limit, 1) - 1}` : text('path');
    }
    case 'write':
      return record.append ? `${text('path')} · +append` : text('path');
    case 'edit':
      return text('path');
    case 'bash':
      return firstLine(text('command'));
    case 'grep':
      return `“${text('pattern')}”${text('path') ? ` · ${text('path')}` : ''}`;
    case 'ls':
      return text('path') || '.';
    default: {
      for (const key of ['url', 'path', 'command', 'query', 'pattern', 'text', 'ref']) {
        if (text(key)) return firstLine(text(key));
      }
      try {
        const json = JSON.stringify(record);
        return json === '{}' ? '' : firstLine(json);
      } catch {
        return '';
      }
    }
  }
}

/** Close a run as failed: record why and mark the step that was mid-flight. */
function failRun(state: CodeRunState, message: string): void {
  state.error = message;
  state.retrying = null;
  state.done = true;
  state.stopReason ??= 'error';
  const broken = state.steps.find((s) => s.status === 'running');
  if (broken) broken.status = 'error';
}

/**
 * A message's text and steps in render order. A live run passes its own
 * timeline; saved runs carry theirs; older messages fall back to steps, then
 * text. Steps whose row is gone and blank text segments are skipped.
 */
export function orderedEntries(
  message: { agentSteps?: AgentStep[]; content: string; metadata?: { codeTimeline?: CodeTimelineEntry[] } },
  liveTimeline?: CodeTimelineEntry[]
): Array<{ key: string; step?: AgentStep; text?: string }> {
  const steps = new Map((message.agentSteps ?? []).map((step) => [step.id, step]));
  let entries = liveTimeline ?? message.metadata?.codeTimeline ?? [];
  if (!entries.length) {
    entries = [...steps.keys()].map((id) => ({ kind: 'step' as const, id }));
    if (message.content) entries.push({ kind: 'text', text: message.content });
  }
  const out: Array<{ key: string; step?: AgentStep; text?: string }> = [];
  entries.forEach((entry, index) => {
    const step = entry.kind === 'step' ? steps.get(entry.id) : undefined;
    // Engine bookkeeping, not work to show: turn rows and output-cap notes
    // (saved by older runs), and todo updates (the Tasks card shows those).
    if (step && (step.id.startsWith('turn-') || step.id.startsWith('length-') || step.toolName === 'todo_write')) return;
    if (step) out.push({ key: `s-${step.id}`, step });
    else if (entry.kind === 'text' && entry.text.trim()) out.push({ key: `t-${index}`, text: entry.text });
  });
  return out;
}

export function eventToStep(event: CodeAgentEvent): AgentStep | null {
  switch (event.type) {
    case 'tool_start':
      return {
        id: event.toolCallId,
        type: TOOL_TYPES[event.toolName] ?? 'tool',
        label: event.label || toolLabel(event.toolName),
        toolName: event.toolName,
        status: 'running',
        detail: event.detail || describeToolArgs(event.toolName, event.args)
      };
    case 'approval_request':
      return {
        id: event.requestId,
        type: 'approval',
        // The row's status already says "Needs approval": name the action itself.
        label: event.kind === 'plan'
          ? copy.codeRun.approvePlan
          : [toolLabel(event.toolName), describeToolArgs(event.toolName, event.args)].filter(Boolean).join(' '),
        toolName: event.toolName,
        status: 'awaiting_approval',
        detail: event.kind === 'plan' ? `${event.diff ?? ''}\n\n${copy.codeRun.planNote}` : event.diff
      };
    case 'compaction_start':
      return { id: `compaction-${event.chatId}`, type: 'planning', label: copy.codeRun.compacting, status: 'running' };
    case 'compaction_end':
      return { id: `compaction-${event.chatId}`, type: 'done', label: copy.codeRun.compacted, status: 'done' };
    default:
      return null;
  }
}

/**
 * Apply one event. Mutates `state` (callers wrap it in reactive state) and
 * returns true when the assistant message changed (content/reasoning/steps)
 * and should be flushed into the chat transcript.
 */
export function applyCodeAgentEvent(state: CodeRunState, event: CodeAgentEvent): boolean {
  switch (event.type) {
    case 'agent_start': {
      // A follow-up restarts the engine loop inside the same run: keep the
      // original start so "worked for" covers the whole piece of work.
      state.startedAt ??= Date.now();
      return false;
    }
    case 'text_delta': {
      appendText(state, event.delta);
      state.retrying = null;
      return true;
    }
    case 'thinking_delta': {
      // Same normalization rule as Home (agent.ts): one owner —
      // sanitizeAgentVisibleText — applied to the whole accumulation, since
      // the strip patterns are multi-line and per-chunk sanitizing would
      // miss patterns split across chunks.
      state.reasoningRaw += event.delta;
      state.reasoning = sanitizeAgentVisibleText(state.reasoningRaw);
      state.retrying = null;
      return true;
    }
    case 'tool_start': {
      const step = eventToStep(event);
      if (step) upsertStep(state, step);
      state.retrying = null;
      return true;
    }
    case 'tool_update': {
      // Only text is output; status objects ({ status: 'running' }) are not
      // (they used to render as "[object Object]").
      const step = state.steps.find((s) => s.id === event.toolCallId);
      const partial = event.partialResult;
      const text = typeof partial === 'string' ? partial : (partial as { output?: unknown } | null)?.output;
      if (step && typeof text === 'string') step.output = text.slice(-6000);
      return true;
    }
    case 'tool_end': {
      const step = state.steps.find((s) => s.id === event.toolCallId);
      if (step) {
        step.status = event.status || (event.isError ? 'error' : 'done');
        const output = event.result != null ? String(event.result) : '';
        if (output) step.output = output.slice(0, 6000);
        if (event.fileChanges?.length) {
          step.fileChanges = event.fileChanges.map((file) => ({ path: file.path, kind: file.kind as CodeAgentFileChange['kind'] }));
        }
        if (event.diffStats?.length) {
          step.diffStats = event.diffStats.map((file) => ({
            path: file.path,
            kind: file.kind as CodeAgentDiffStat['kind'],
            additions: file.additions,
            deletions: file.deletions
          }));
        }
      }
      return true;
    }
    // Turns are an engine detail: one run reads as one piece of work, with a
    // single "worked for" footer instead of a row per model call.
    case 'turn_start':
      // Where this turn's output begins, in case a retry discards it.
      state.turnMark = { content: state.content.length, timeline: state.timeline.length, lastText: lastTextLength(state), reasoning: state.reasoningRaw.length };
      return false;
    case 'turn_end':
      return false;
    case 'compaction_start':
    case 'compaction_end': {
      const step = eventToStep(event);
      if (step) upsertStep(state, step);
      return true;
    }
    case 'approval_request': {
      const step = eventToStep(event);
      if (step) upsertStep(state, step);
      return true;
    }
    case 'approval_resolved': {
      const step = state.steps.find((s) => s.id === event.requestId);
      if (step) {
        step.status = event.decision === 'allow' ? 'done' : 'error';
        step.detail = event.decision === 'allow' ? copy.codeRun.approved : copy.codeRun.denied;
      }
      return true;
    }
    case 'checkpoint_captured':
      return false;
    case 'checkpoint_finalized': {
      for (const file of event.files) {
        state.diffStats.push({
          path: file.path,
          kind: file.kind as 'created' | 'modified' | 'deleted',
          additions: file.additions,
          deletions: file.deletions
        });
        state.fileChanges.push({
          path: file.path,
          kind: file.kind as 'created' | 'modified' | 'deleted'
        });
      }
      // Attach the cumulative diff to the most recent file-writing step.
      const writing = [...state.steps].reverse().find((s) => s.type !== 'approval' && (s.toolName === 'write' || s.toolName === 'edit'));
      if (writing) {
        writing.diffStats = [...state.diffStats];
        writing.fileChanges = [...state.fileChanges];
      }
      return true;
    }
    case 'usage': {
      state.usage = {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        contextWindow: event.contextWindow
      };
      return false; // ring data only — no transcript change
    }
    case 'llm_retry': {
      state.retrying = { attempt: event.attempt, delayMs: event.delayMs };
      if (event.discardPartial) rollBackTurn(state);
      return true;
    }
    case 'length_continue':
      // The loop continues on its own; a row per cap hit was only noise.
      state.truncatedOnce = true;
      return false;
    case 'todo_update': {
      state.todos = event.todos.map((todo) => ({ ...todo }));
      return true;
    }
    case 'artifact_created': {
      state.artifacts = [...state.artifacts, { ...event.artifact }];
      return false; // ring data only — rendered on demand, not in the transcript
    }
    case 'artifact_list': {
      state.artifacts = event.artifacts.map((artifact) => ({ ...artifact }));
      return false;
    }
    case 'sources': {
      state.sources = event.sources.map((source) => ({ ...source }));
      return false;
    }
    case 'sources_delta': {
      const seen = new Set(state.sources.map((source) => source.url));
      for (const source of event.sources) {
        if (!seen.has(source.url)) {
          seen.add(source.url);
          state.sources.push({ ...source });
        }
      }
      return false;
    }
    case 'activity': {
      state.activity = event.activity;
      return false;
    }
    case 'run_summary': {
      state.summary = event.summary;
      // A summary carrying an error finalizes the run exactly like the
      // error event; a clean summary is ring data for the end-of-run UI.
      if (event.summary.error && !state.error) {
        failRun(state, event.summary.error);
        return true;
      }
      return false;
    }
    case 'content_replace': {
      // The engine rewrote the whole answer: keep the steps where they were
      // and put the new text after them.
      state.content = event.content;
      state.timeline = [...state.timeline.filter((entry) => entry.kind === 'step'), { kind: 'text', text: event.content }];
      state.retrying = null;
      return true;
    }
    case 'steer_acknowledged': {
      // Authoritative drain receipt; the store's queuedCount approximation
      // (code.svelte.ts) reconciles against it. No transcript change.
      return false;
    }
    case 'error': {
      // An error can be the last event of a run: the engine's prompt()
      // rejection path emits `error` without a following `agent_end`, which
      // left the assistant placeholder streaming forever. Close the run here
      // defensively; a later agent_end still refines the stop reason.
      failRun(state, event.message);
      return true;
    }
    case 'agent_end': {
      state.done = true;
      state.stopReason = event.stopReason;
      state.hitTurnLimit = !!event.hitTurnLimit;
      state.endedAt = Date.now();
      state.retrying = null;
      // A still-running step at the end of a run only means failure if the
      // run itself failed; on success it was simply never closed out.
      const running = state.steps.find((s) => s.status === 'running');
      if (running) running.status = state.error ? 'error' : 'done';
      return true;
    }
    default:
      return false;
  }
}
