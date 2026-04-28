import type { AgentArtifact, AgentStep } from '$lib/types/chat';
import type { ManagedAgentTask } from '$lib/types/tauri';
import { invoke, listen } from './tauri';

type StartManagedTaskInput = {
  chatId: string;
  prompt: string;
  mode?: string;
  searchMode?: string;
  workContext?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

type UpdateManagedTaskInput = {
  taskId: string;
  status?: string;
  content?: string;
  reasoning?: string;
  error?: string;
  artifact?: AgentArtifact | null;
  steps?: AgentStep[];
  workContext?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

function toManagedArtifact(artifact?: AgentArtifact | null) {
  if (!artifact) {
    return undefined;
  }

  return {
    title: artifact.title,
    files: artifact.files,
    preview_html: artifact.previewHtml ?? null,
    thumbnail: null,
    metadata: null
  };
}

function toManagedSteps(steps?: AgentStep[]) {
  if (!steps) {
    return undefined;
  }

  return steps.map((step) => ({
    id: step.id,
    type: step.type,
    label: step.label,
    status: step.status,
    detail: step.detail ?? null,
    output: step.output ?? null
  }));
}

export async function startManagedAgentTask(input: StartManagedTaskInput): Promise<ManagedAgentTask> {
  return invoke<ManagedAgentTask>('agent_start_task', {
    input: {
      chat_id: input.chatId,
      prompt: input.prompt,
      mode: input.mode,
      search_mode: input.searchMode,
      work_context: input.workContext ?? null,
      metadata: input.metadata ?? null
    }
  });
}

export async function updateManagedAgentTask(input: UpdateManagedTaskInput): Promise<ManagedAgentTask> {
  return invoke<ManagedAgentTask>('agent_update_task', {
    input: {
      task_id: input.taskId,
      status: input.status,
      content: input.content,
      reasoning: input.reasoning,
      error: input.error,
      artifact: toManagedArtifact(input.artifact),
      steps: toManagedSteps(input.steps),
      work_context: input.workContext ?? null,
      metadata: input.metadata ?? null
    }
  });
}

export async function cancelManagedAgentTask(taskId: string): Promise<ManagedAgentTask> {
  return invoke<ManagedAgentTask>('agent_cancel_task', { taskId });
}

export async function getManagedAgentTask(taskId: string): Promise<ManagedAgentTask | null> {
  return invoke<ManagedAgentTask | null>('agent_get_task', { taskId });
}

export async function listManagedAgentTasks(chatId?: string): Promise<ManagedAgentTask[]> {
  return invoke<ManagedAgentTask[]>('agent_list_tasks', { chatId });
}

export async function deleteManagedAgentTask(taskId: string): Promise<boolean> {
  return invoke<boolean>('agent_delete_task', { taskId });
}

export async function clearManagedAgentHistory(chatId?: string): Promise<void> {
  await invoke<void>('agent_clear_history', { chatId });
}

export async function onManagedAgentTaskUpdate(
  handler: (task: ManagedAgentTask) => void
): Promise<() => void> {
  return listen<ManagedAgentTask>('agent-task-updated', handler);
}
