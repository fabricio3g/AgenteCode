// Agente run state: folds CodeAgentEvent pushes into AgentSteps + streamed
// content. Pure logic — no Svelte, no IPC — so it is directly testable.

import type { CodeAgentEvent, CodeArtifactRef, CodeChild, CodeRunSummary, CodeSourceRef, CodeSpend, CodeStopReason, CodeTodoItem, AgentActivityKey, ContextBreakdown } from '$shared/agente-protocol';
import type { AgentStep, ChatMessage, CodeAgentDiffStat, CodeAgentFileChange, CodeTimelineEntry } from '$lib/types/chat';
import { sanitizeAgentVisibleText } from '$lib/services/agent-parsing';
import { copy } from '$lib/copy';
import { linkChildToStep } from './subagent-row';
import { addCallSpend, emptySpend } from '$shared/accounting';
export { emptySpend } from '$shared/accounting';

export interface AgenteUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  breakdown?: ContextBreakdown;
}

export interface CodeRunState {
  content: string;
  compactionTokens?: number;
  phase?: 'starting' | 'requesting' | 'thinking' | 'writing' | 'compacting';
  /** Text segments and steps in arrival order — what the transcript renders. */
  timeline: CodeTimelineEntry[];
  /** Wall-clock bounds of the run (agent_start → agent_end). */
  startedAt?: number;
  endedAt?: number;
  /** Accumulated active intervals; paused time is never included. */
  elapsedMs?: number;
  activeStartedAt?: number;
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
  tokensPerSecond?: number;
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
  /** Inherited tasks stay still until the agent updates the list this turn. */
  todosUpdated?: boolean;
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
  children: CodeChild[];
  spend: CodeSpend;
  diagnostics: string[];
  /** Provider call IDs may repeat across model rounds; UI rows remain unique. */
  toolStepIds?: Map<string, string>;
  childToolStepIds?: Map<string, Map<string, string>>;
  generation?: { outputBytes: number; toolName?: string | null };
  /** The tool call the model is writing right now, before it runs ("Preparing edit… 3 KB"). */
  preparing?: { toolName: string; bytes: number; startBytes: number } | null;
  /** When the last event arrived: silence past a few seconds is worth saying. */
  lastEventAt?: number;
  /**
   * The reader asked to stop. The engine takes a moment to unwind, so the UI
   * says it at once: motion halts and the run stops looking busy while the
   * abort travels.
   */
  stopping?: boolean;
}

export function createCodeRunState(): CodeRunState {
  return { phase: undefined, startedAt: undefined, endedAt: undefined, elapsedMs: 0, activeStartedAt: undefined, lastEventAt: undefined, stopping: false, preparing: null, retrying: null, hitTurnLimit: false, summary: undefined, turnMark: undefined, generation: undefined, activity: undefined, content: '', timeline: [], reasoning: '', reasoningRaw: '', steps: [], diffStats: [], fileChanges: [], done: false, todos: [], todosUpdated: false, truncatedOnce: false, artifacts: [], sources: [], children: [], spend: emptySpend(), diagnostics: [] };
}

/** The latest explicit snapshot wins, including an intentionally empty list. */
export function conversationTodos(messages: readonly ChatMessage[]): CodeTodoItem[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && Array.isArray(message.metadata?.codeTodos)) {
      return message.metadata.codeTodos.map((todo) => ({ ...todo }));
    }
  }
  return [];
}

export function codeRunElapsed(state: Pick<CodeRunState, 'elapsedMs' | 'activeStartedAt' | 'startedAt' | 'endedAt'>, now = Date.now()): number {
  if (state.elapsedMs !== undefined) return state.elapsedMs + (state.activeStartedAt === undefined ? 0 : Math.max(0, now - state.activeStartedAt));
  // Older saved runs have wall-clock bounds only.
  return state.startedAt === undefined ? 0 : Math.max(0, (state.endedAt ?? now) - state.startedAt);
}

function stopRunClock(state: CodeRunState): void {
  state.elapsedMs = codeRunElapsed(state);
  state.activeStartedAt = undefined;
  state.endedAt = Date.now();
}

/** Point the `task` step that asked for this child at it, once. */
function linkChild(state: CodeRunState, child: CodeChild, description: string): void {
  const stepId = linkChildToStep(state.steps, description);
  if (!stepId) return;
  const step = state.steps.find((candidate) => candidate.id === stepId);
  if (step) step.subagentId = child.id;
}

function applyRuntimeEvent(state: CodeRunState, event: Extract<CodeAgentEvent, { type: 'runtime_event' }>): boolean {
  const value = event.event;
  const id = event.parentRunId || ('run_id' in value ? value.run_id : undefined);
  let child = id ? state.children.find((item) => item.id === id) : undefined;
  if (id && !child) {
    child = { id, kind: 'subagent', description: '', status: 'running', text: '', tools: [], spend: emptySpend(), startedAt: Date.now() };
    state.children.push(child);
  }
  switch (value.type) {
    case 'thinking':
      if (child) return false;
      state.phase = 'requesting';
      state.preparing = null;
      return false;
    case 'child_started':
      Object.assign(child!, { kind: value.kind, description: value.description, status: 'running', model: value.model });
      // One spawn, one row: hand the child to the `task` step that asked for it,
      // so the transcript draws its card there instead of a generic tool row.
      linkChild(state, child!, value.description);
      return true;
    case 'assistant_delta':
      if (!child) return false;
      child.text += value.text;
      return true;
    case 'child_delta':
      child!.text += value.text;
      return true;
    case 'child_tool': {
      const byChild = state.childToolStepIds ??= new Map();
      let ids = byChild.get(child!.id);
      if (!ids) { ids = new Map(); byChild.set(child!.id, ids); }
      const callId = invocationId(child!.tools, value.call_id, ids, !!value.name && !value.finished);
      let tool = child!.tools.find((item) => item.id === callId);
      if (!tool) {
        tool = { id: callId, name: value.name, output: '', status: 'running' };
        child!.tools.push(tool);
      }
      if (value.name) tool.name = value.name;
      tool.output = value.finished || value.name ? value.content : (tool.output + value.content).slice(-32_768);
      tool.status = value.finished ? (value.is_error ? 'error' : 'done') : 'running';
      return true;
    }
    case 'child_finished':
    case 'child_completed_notice':
      Object.assign(child!, { summary: value.summary, status: value.type === 'child_finished' ? (value.is_error ? 'error' : 'done') : (value.status === 'completed' ? 'done' : 'error') });
      child!.finishedAt ??= Date.now();
      return true;
    case 'call_usage': {
      if (!child && state.phase === 'compacting') state.compactionTokens = (state.compactionTokens ?? 0) + value.usage.prompt_tokens + value.usage.completion_tokens + value.usage.cache_read_tokens + value.usage.cache_creation_tokens;
      // The session includes its children; a child also keeps its own subtotal.
      for (const spend of child ? [state.spend, child.spend] : [state.spend]) {
        addCallSpend(spend, value);
      }
      return true;
    }
    case 'diagnostic':
      state.diagnostics = [...state.diagnostics, value.message].slice(-20);
      return true;
    case 'generation_progress':
      if (child) return false;
      state.generation = { outputBytes: value.output_bytes, toolName: value.tool_name };
      state.preparing = trackPreparing(state.preparing, value.tool_name, value.output_bytes);
      return true;
    case 'tool_heartbeat':
      return false;
    default:
      return false;
  }
}

/** The tool call being written: its name and how much of it has streamed. */
export function trackPreparing(current: CodeRunState['preparing'], toolName: string | null | undefined, outputBytes: number): CodeRunState['preparing'] {
  if (!toolName) return null;
  if (current?.toolName !== toolName) return { toolName, bytes: 0, startBytes: outputBytes };
  return { ...current, bytes: Math.max(0, outputBytes - current.startBytes) };
}

/** Stable row IDs keep repeated provider IDs from overwriting earlier invocations. */
function invocationId(rows: readonly { id: string; status: string }[], callId: string, ids: Map<string, string>, starting: boolean): string {
  let id = ids.get(callId) ?? callId;
  const previous = rows.find(row => row.id === id);
  if (starting && previous && (previous.status === 'done' || previous.status === 'error')) {
    let suffix = rows.length;
    do { id = `${callId}#${suffix++}`; } while (rows.some(row => row.id === id));
  }
  ids.set(callId, id);
  return id;
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
  return last && last.kind !== 'step' ? last.text.length : 0;
}

/** Drop what the current turn wrote: the model is replaying it. */
function rollBackTurn(state: CodeRunState): void {
  const mark = state.turnMark;
  if (!mark) return;
  state.content = state.content.slice(0, mark.content);
  state.timeline = state.timeline.slice(0, mark.timeline);
  const last = state.timeline[state.timeline.length - 1];
  if (last && last.kind !== 'step') last.text = last.text.slice(0, mark.lastText);
  state.reasoningRaw = state.reasoningRaw.slice(0, mark.reasoning);
  state.reasoning = sanitizeAgentVisibleText(state.reasoningRaw);
}

/**
 * The entry a delta of `kind` extends: the last one, or the run it interrupted.
 *
 * A provider that streams `reasoning_content` and `content` in the same chunk
 * (OpenRouter's `reasoning`, several gateways) makes the loop emit a thinking
 * delta and a text delta for every chunk. Appending blindly produced
 * [thought, word, thought, word, …] and one sentence was drawn as three rows.
 *
 * Within one response the reasoning precedes the reply, so when the same kind
 * sits one entry back with only the other kind between them, the delta joins
 * that run. A step in between means a new response, and a new row: a second
 * thought after a tool call is a real second thought.
 */
function openRun(state: CodeRunState, kind: 'text' | 'thinking') {
  const last = state.timeline[state.timeline.length - 1];
  if (!last || last.kind === 'step') return undefined;
  if (last.kind === kind) return last;
  const before = state.timeline[state.timeline.length - 2];
  return before?.kind === kind ? before : undefined;
}

function appendThinking(state: CodeRunState, delta: string): void {
  const run = openRun(state, 'thinking');
  if (run) run.text += delta;
  else state.timeline.push({ kind: 'thinking', text: delta });
}

function appendText(state: CodeRunState, delta: string): void {
  const run = openRun(state, 'text');
  if (run) {
    run.text += delta;
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
 * Keys that read as "what this call is about", tried in order for any tool
 * without a case of its own.
 */
const SUBJECT_KEYS = ['url', 'path', 'command', 'query', 'pattern', 'text', 'ref', 'title', 'description', 'name', 'id', 'to', 'new', 'line', 'prompt'];

/** The subagent type a `task` call asked for; `task` defaults to `general-purpose`. */
function subagentTypeOf(args: unknown): string {
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const kind = record.subagent_type;
  return typeof kind === 'string' && kind.trim() ? kind : 'general-purpose';
}

/**
 * The child a `task_output` call waits on: the runtime names a child's run by
 * its subagent id, so the row can carry that child's live card instead of a
 * bare id.
 */
function awaitedChildOf(toolName: string, args: unknown): { subagentId: string } | Record<string, never> {
  if (toolName !== 'task_output') return {};
  const id = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  return typeof id.task_id === 'string' && id.task_id.trim() ? { subagentId: id.task_id.trim() } : {};
}

/**
 * What a tool call is about, in one short line: a path, a command, a search.
 *
 * Every tool that ships with the agent has a case here, and the fallback for an
 * unknown one (an MCP tool) is its first readable field. It never stringifies
 * the arguments: `Task {"subagent_type":…}` and a `present_plan` call dumping
 * its whole markdown into one chip were both this function's old default.
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
    // A spawn reads as its own description; the subagent row shows the type.
    case 'task':
      return firstLine(text('description') || text('subagent_type'));
    case 'task_output':
    case 'kill_task':
      return firstLine(text('description') || text('task_id'));
    case 'present_plan':
      return firstLine(text('title'));
    case 'skill':
      return firstLine(text('name'));
    case 'process_output':
    case 'process_stop':
      return firstLine(text('id'));
    case 'message_bot':
      return [text('to'), firstLine(text('message'))].filter(Boolean).join(' · ');
    case 'memory_update':
      return firstLine(text('new') || text('line'));
    default: {
      for (const key of SUBJECT_KEYS) {
        if (text(key)) return firstLine(text(key));
      }
      return '';
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
  stopRunClock(state);
}

/**
 * A message's text and steps in render order. A live run passes its own
 * timeline; saved runs carry theirs; older messages fall back to steps, then
 * text. Steps whose row is gone and blank text segments are skipped.
 */
export type OrderedEntry = { key: string; step?: AgentStep; text?: string; thinking?: string };

export function orderedEntries(
  message: { agentSteps?: AgentStep[]; content: string; reasoning?: string; metadata?: { codeTimeline?: CodeTimelineEntry[] } },
  liveTimeline?: CodeTimelineEntry[]
): OrderedEntry[] {
  const steps = new Map((message.agentSteps ?? []).map((step) => [step.id, step]));
  let entries = liveTimeline ?? message.metadata?.codeTimeline ?? [];
  if (!entries.length) {
    entries = [...steps.keys()].map((id) => ({ kind: 'step' as const, id }));
    if (message.content) entries.push({ kind: 'text', text: message.content });
  }
  // Runs saved before reasoning had a place in the timeline: it came first.
  if (message.reasoning?.trim() && !entries.some((entry) => entry.kind === 'thinking')) {
    entries = [{ kind: 'thinking', text: message.reasoning }, ...entries];
  }
  const out: OrderedEntry[] = [];
  const seenSteps = new Set<string>();
  entries.forEach((entry, index) => {
    const step = entry.kind === 'step' ? steps.get(entry.id) : undefined;
    // Older runs saved turn and output-cap rows. Todo updates live in the Tasks panel.
    if (step && (step.id.startsWith('turn-') || step.id.startsWith('length-') || TODO_TOOLS.has(step.toolName ?? ''))) return;
    if (step) {
      if (seenSteps.has(step.id)) return;
      seenSteps.add(step.id);
      out.push({ key: `s-${step.id}`, step });
    }
    else if (entry.kind === 'text' && entry.text.trim()) out.push({ key: `t-${index}`, text: entry.text });
    else if (entry.kind === 'thinking') {
      const thinking = sanitizeAgentVisibleText(entry.text);
      if (thinking.trim()) out.push({ key: `r-${index}`, thinking });
    }
  });
  return out;
}

const TODO_TOOLS = new Set(['todo_write', 'todo']);

function eventToStep(event: CodeAgentEvent): AgentStep | null {
  switch (event.type) {
    case 'tool_start':
      return {
        id: event.toolCallId,
        type: TOOL_TYPES[event.toolName] ?? 'tool',
        label: event.label || toolLabel(event.toolName),
        toolName: event.toolName,
        status: 'running',
        detail: event.detail || describeToolArgs(event.toolName, event.args),
        ...(event.args != null ? { toolInput: formatTraceInput(event.args) } : {}),
        // A spawn names its kind on its own row before the child registers, so
        // the row reads "Explore · …" from the first frame.
        ...(event.toolName === 'task' ? { subagentType: subagentTypeOf(event.args) } : {}),
        ...awaitedChildOf(event.toolName, event.args),
        startedAt: Date.now()
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
      return { id: `compaction-${event.chatId}`, type: 'planning', label: copy.codeRun.compacting, status: 'running', model: event.model ?? undefined };
    case 'compaction_end':
      return { id: `compaction-${event.chatId}`, type: 'done', label: copy.codeRun.compacted, status: event.success ? 'done' : 'error', detail: event.tokensBefore !== undefined ? `${event.tokensBefore.toLocaleString()} → ${(event.tokensAfter ?? 0).toLocaleString()} tokens · ${event.smart ? 'summarized' : 'trimmed'}` : undefined };
    default:
      return null;
  }
}

/** Preserve the tool's real input for inspection, bounded like streamed output. */
function formatTraceInput(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > 32_768 ? `${text.slice(0, 32_768)}\n…` : text;
  } catch { return ''; }
}

/**
 * Apply one event. Mutates `state` (callers wrap it in reactive state) and
 * returns true when the assistant message changed (content/reasoning/steps)
 * and should be flushed into the chat transcript.
 */
export function applyCodeAgentEvent(state: CodeRunState, event: CodeAgentEvent): boolean {
  state.lastEventAt = Date.now();
  switch (event.type) {
    case 'runtime_event':
      return applyRuntimeEvent(state, event);
    case 'agent_start': {
      state.phase = 'starting';
      state.startedAt ??= Date.now();
      state.activeStartedAt ??= Date.now();
      state.endedAt = undefined;
      return false;
    }
    case 'generation_stats': {
      if (Number.isFinite(event.tokensPerSecond) && event.tokensPerSecond > 0) state.tokensPerSecond = event.tokensPerSecond;
      return false;
    }
    case 'text_delta': {
      state.phase = 'writing';
      appendText(state, event.delta);
      state.preparing = null;
      state.retrying = null;
      return true;
    }
    case 'thinking_delta': {
      state.phase = 'thinking';
      // Same normalization rule as Home (agent.ts): one owner —
      // sanitizeAgentVisibleText — applied to the whole accumulation, since
      // the strip patterns are multi-line and per-chunk sanitizing would
      // miss patterns split across chunks.
      state.reasoningRaw += event.delta;
      state.reasoning = sanitizeAgentVisibleText(state.reasoningRaw);
      appendThinking(state, event.delta);
      state.preparing = null;
      state.retrying = null;
      return true;
    }
    case 'tool_start': {
      const step = eventToStep(event);
      if (step) {
        const ids = state.toolStepIds ??= new Map();
        step.id = invocationId(state.steps, event.toolCallId, ids, true);
        upsertStep(state, step);
      }
      state.preparing = null;
      state.retrying = null;
      return true;
    }
    case 'tool_update': {
      // Only text is output; status objects ({ status: 'running' }) are not
      // (they used to render as "[object Object]").
      const step = state.steps.find((s) => s.id === (state.toolStepIds?.get(event.toolCallId) ?? event.toolCallId));
      const partial = event.partialResult;
      const text = typeof partial === 'string' ? partial : (partial as { output?: unknown } | null)?.output;
      if (step && (step.status === 'running' || step.status === 'pending') && typeof text === 'string') step.output = text.slice(-32_768);
      return true;
    }
    case 'tool_end': {
      const step = state.steps.find((s) => s.id === (state.toolStepIds?.get(event.toolCallId) ?? event.toolCallId));
      if (step) {
        step.status = event.status || (event.isError ? 'error' : 'done');
        // Freeze the clock: the row keeps its duration once it has settled, so a
        // folded block can say how long its work took without opening it.
        step.durationMs ??= step.startedAt === undefined ? undefined : Math.max(0, Date.now() - step.startedAt);
        const output = event.result != null ? String(event.result) : '';
        if (output) step.output = output;
        if (event.fileChanges?.length) {
          step.fileChanges = event.fileChanges.map((file) => ({ path: file.path, kind: file.kind as CodeAgentFileChange['kind'] }));
        }
        if (event.diffStats?.length) {
          step.diffStats = event.diffStats.map((file) => ({
            path: file.path,
            kind: file.kind as CodeAgentDiffStat['kind'],
            additions: file.additions,
            deletions: file.deletions,
            ...(file.patch ? { patch: file.patch } : {})
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
      if (event.type === 'compaction_start') state.compactionTokens = undefined;
      state.phase = event.type === 'compaction_start' ? 'compacting' : 'requesting';
      const step = eventToStep(event);
      if (step && event.type === 'compaction_end' && state.compactionTokens !== undefined) step.detail = `${step.detail ?? ''} · ${state.compactionTokens.toLocaleString()} model tokens used`;
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
      // Engines that report files only per turn: the last edit carries them.
      // Steps that came with their own changes (and patches) keep those.
      const writing = [...state.steps].reverse().find((s) => s.type !== 'approval' && (s.toolName === 'write' || s.toolName === 'edit'));
      if (writing && !writing.diffStats?.length) {
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
        contextWindow: event.contextWindow,
        breakdown: event.breakdown ?? state.usage?.breakdown
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
      state.todosUpdated = true;
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
      state.timeline = [...state.timeline.filter((entry) => entry.kind !== 'text'), { kind: 'text', text: event.content }];
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
      stopRunClock(state);
      state.retrying = null;
      state.preparing = null;
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
