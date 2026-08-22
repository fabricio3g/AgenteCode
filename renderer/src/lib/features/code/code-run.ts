// Agente run state: folds CodeAgentEvent pushes into AgentSteps + streamed
// content. Pure logic — no Svelte, no IPC — so it is directly testable.

import type { CodeAgentEvent, CodeStopReason, CodeTodoItem } from './code-protocol';
import type { AgentStep, CodeAgentDiffStat, CodeAgentFileChange } from '$lib/types/chat';

export interface AgenteUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
}

export interface CodeRunState {
  content: string;
  reasoning: string;
  steps: AgentStep[];
  diffStats: CodeAgentDiffStat[];
  fileChanges: CodeAgentFileChange[];
  usage?: AgenteUsage;
  error?: string;
  done: boolean;
  /** Why the run ended — drives the end-of-run status chip. */
  stopReason?: CodeStopReason;
  /** Live retry notice (dsh llm/retry); cleared by the next content event. */
  retrying?: { attempt: number; delayMs: number } | null;
  /** The model-maintained todo list, updated live via todo_update. */
  todos: CodeTodoItem[];
  /** A length-truncated turn was auto-continued at least once this run. */
  truncatedOnce: boolean;
}

export function createCodeRunState(): CodeRunState {
  return { content: '', reasoning: '', steps: [], diffStats: [], fileChanges: [], done: false, todos: [], truncatedOnce: false };
}

function upsertStep(state: CodeRunState, step: AgentStep): void {
  const index = state.steps.findIndex((s) => s.id === step.id);
  if (index >= 0) state.steps[index] = { ...state.steps[index], ...step };
  else state.steps.push(step);
}

function argsPreview(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, 200);
  try {
    return JSON.stringify(args ?? {}).slice(0, 200);
  } catch {
    return '';
  }
}

export function eventToStep(event: CodeAgentEvent): AgentStep | null {
  switch (event.type) {
    case 'tool_start':
      return {
        id: event.toolCallId,
        type: 'tool',
        label: event.toolName,
        status: 'running',
        detail: argsPreview(event.args)
      };
    case 'turn_start':
      return { id: `turn-${event.turnIndex}`, type: 'planning', label: `Turn ${event.turnIndex}`, status: 'running' };
    case 'turn_end':
      return { id: `turn-${event.turnIndex}`, type: 'done', label: `Turn ${event.turnIndex} complete`, status: 'done' };
    case 'approval_request':
      return {
        id: event.requestId,
        type: 'approval',
        label: `Approval: ${event.toolName}`,
        status: 'awaiting_approval',
        detail: event.diff
      };
    case 'compaction_start':
      return { id: `compaction-${event.chatId}`, type: 'planning', label: 'Compacting context', status: 'running' };
    case 'compaction_end':
      return { id: `compaction-${event.chatId}`, type: 'done', label: 'Context compacted', status: 'done' };
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
    case 'text_delta': {
      state.content += event.delta;
      state.retrying = null;
      return true;
    }
    case 'thinking_delta': {
      state.reasoning += event.delta;
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
      const step = state.steps.find((s) => s.id === event.toolCallId);
      if (step && event.partialResult != null) {
        step.output = String(event.partialResult).slice(0, 6000);
      }
      return true;
    }
    case 'tool_end': {
      const step = state.steps.find((s) => s.id === event.toolCallId);
      if (step) {
        step.status = event.isError ? 'error' : 'done';
        const output = event.result != null ? String(event.result) : '';
        if (output) step.output = output.slice(0, 6000);
      }
      return true;
    }
    case 'turn_start':
    case 'turn_end':
    case 'compaction_start':
    case 'compaction_end': {
      const step = eventToStep(event);
      if (step) upsertStep(state, step);
      return true;
    }
    case 'approval_request': {
      const step: AgentStep = {
        id: event.requestId,
        type: 'approval',
        label: event.kind === 'plan' ? 'Approve plan' : `Approval: ${event.toolName}`,
        status: 'awaiting_approval',
        detail: event.kind === 'plan'
          ? `${event.diff ?? ''}\n\nApproving lets Agente start editing; every edit still asks individually.`
          : event.diff
      };
      upsertStep(state, step);
      return true;
    }
    case 'approval_resolved': {
      const step = state.steps.find((s) => s.id === event.requestId);
      if (step) {
        step.status = event.decision === 'allow' ? 'done' : 'error';
        step.detail = event.decision === 'allow' ? 'Approved' : 'Denied';
      }
      return true;
    }
    case 'checkpoint_captured': {
      const step = state.steps.find((s) => s.id === `turn-${event.turnIndex}`);
      if (step) step.output = `checkpoint: ${event.fileCount} file(s) captured`;
      return true;
    }
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
      // Attach the cumulative diff to the most recent mutating step, if any.
      const writing = [...state.steps].reverse().find((s) => /write|edit/i.test(s.label));
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
      return true;
    }
    case 'length_continue': {
      state.truncatedOnce = true;
      const step: AgentStep = {
        id: `turn-${event.turnIndex}`,
        type: 'planning',
        label: `Turn ${event.turnIndex} hit the output cap — continuing`,
        status: 'done'
      };
      upsertStep(state, step);
      return true;
    }
    case 'todo_update': {
      state.todos = event.todos.map((todo) => ({ ...todo }));
      return true;
    }
    case 'error': {
      state.error = event.message;
      return true;
    }
    case 'agent_end': {
      state.done = true;
      state.stopReason = event.stopReason;
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
