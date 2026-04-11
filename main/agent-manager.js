import { randomUUID } from 'node:crypto';
import { getMainWindow } from './index.js';
import { AgentRunner } from './agent-runner.js';
import { allTools } from './agent-tools/index.js';

const agentRunner = new AgentRunner();
agentRunner.tools = allTools;
for (const tool of allTools) {
  agentRunner.enabledTools.set(tool.name, true);
}

// In-memory agent task store
const agentTasks = new Map();

function emitTaskUpdate(task) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent-task-updated', task);
  }
}

export async function agentStartTask({ input }) {
  const task = {
    id: randomUUID(),
    chat_id: input.chat_id,
    prompt: input.prompt,
    status: 'pending',
    mode: input.mode || 'default',
    search_mode: input.search_mode || 'auto',
    created_at: Date.now(),
    updated_at: Date.now(),
    started_at: null,
    completed_at: null,
    content: null,
    reasoning: null,
    error: null,
    work_context: input.work_context || null,
    metadata: input.metadata || null,
    artifact: null,
    steps: []
  };

  agentTasks.set(task.id, task);
  emitTaskUpdate(task);
  return task;
}

export async function agentUpdateTask({ input }) {
  const task = agentTasks.get(input.task_id);
  if (!task) throw new Error(`Task not found: ${input.task_id}`);

  if (input.status) task.status = input.status;
  if (input.content !== undefined) task.content = input.content;
  if (input.reasoning !== undefined) task.reasoning = input.reasoning;
  if (input.error !== undefined) task.error = input.error;
  if (input.artifact !== undefined) task.artifact = input.artifact;
  if (input.steps !== undefined) task.steps = input.steps;
  if (input.work_context !== undefined) task.work_context = input.work_context;
  if (input.metadata !== undefined) task.metadata = input.metadata;

  task.updated_at = Date.now();

  if (task.status === 'running' && !task.started_at) {
    task.started_at = Date.now();
  }
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    task.completed_at = Date.now();
  }

  emitTaskUpdate(task);
  return task;
}

export async function agentCancelTask(taskId) {
  const task = agentTasks.get(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  task.status = 'cancelled';
  task.updated_at = Date.now();
  task.completed_at = Date.now();
  emitTaskUpdate(task);
  return task;
}

export async function agentGetTask(taskId) {
  return agentTasks.get(taskId) || null;
}

export async function agentListTasks(chatId) {
  const tasks = Array.from(agentTasks.values());
  if (chatId) return tasks.filter(t => t.chat_id === chatId);
  return tasks;
}

export async function agentDeleteTask(taskId) {
  return agentTasks.delete(taskId);
}

export async function agentClearHistory(chatId) {
  if (chatId) {
    for (const [id, task] of agentTasks) {
      if (task.chat_id === chatId) agentTasks.delete(id);
    }
  } else {
    agentTasks.clear();
  }
}

export { agentRunner };
