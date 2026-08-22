// ── todo_write tool ────────────────────────────────────────────────────
// The model-maintained task list (dsh's todo pattern): the call replaces
// the WHOLE list, at most one item may be in_progress, and completion is
// immediate — never batched. The list is announced to the renderer through
// a todo_update event and injected into every system prompt, so long tasks
// stay on track and visible.

import { z } from 'zod';
import { defineTool } from './define-tool.ts';
import type { TodoItem } from '../core/types.ts';

/** Per-session storage for the current list. */
export interface TodoStore {
  items: TodoItem[];
}

const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

/**
 * Validate and canonicalize a model-supplied list: trimmed non-empty unique
 * content, known statuses, at most one in_progress. Throws with a message
 * the model can act on.
 */
export function normalizeTodos(raw: Array<{ content?: unknown; status?: unknown }>): TodoItem[] {
  const todos: TodoItem[] = [];
  const seen = new Set<string>();
  let active = 0;
  for (const entry of raw) {
    const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
    if (!content) {
      throw new Error('invalid todo: `content` must be a non-empty string');
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
    }
    seen.add(content);
    const status = entry?.status;
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoItem['status'])) {
      throw new Error(
        `invalid todo ${JSON.stringify(content)}: \`status\` must be one of pending | in_progress | completed`
      );
    }
    if (status === 'in_progress') active += 1;
    todos.push({ content, status: status as TodoItem['status'] });
  }
  if (active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`);
  }
  return todos;
}

function summarize(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.filter((t) => t.status === 'in_progress').length;
  return `Todo list updated: ${todos.length} task(s) — ${done} completed, ${active} in progress, ${todos.length - done - active} pending.`;
}

export function createTodoTool(store: TodoStore) {
  return defineTool({
    name: 'todo_write',
    description:
      'Write the COMPLETE task list for the current task, replacing any previous list. '
      + 'Use it for multi-step work; skip it for trivial single-step tasks. Mark a todo '
      + '`completed` the moment it is done (do not batch completions), keep exactly one '
      + '`in_progress`, and allow none only when all work is finished. Statuses: '
      + '`pending` (not started), `in_progress` (being worked on now), `completed` (done).',
    schema: z.object({
      todos: z.array(
        z.object({
          content: z.string().describe('What the task is — a short imperative line.'),
          status: z.enum(['pending', 'in_progress', 'completed'])
        })
      ).describe('The COMPLETE task list, replacing any previous list.')
    }),
    executionMode: 'parallel',
    async execute(args, ctx) {
      const todos = normalizeTodos(args.todos);
      store.items = todos;
      ctx.emit?.({ type: 'todo_update', todos });
      return { content: summarize(todos) };
    }
  });
}
