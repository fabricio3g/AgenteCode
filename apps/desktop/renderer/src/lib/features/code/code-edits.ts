// Undo / redo of the agent's file edits, for every place that offers it (the
// composer's commands, the edited-files card under a reply).

import type { ChatSession } from '$lib/types/chat';
import { toastStore } from '$lib/stores/toast.svelte';
import { codeStore } from './code.svelte';
import { codeEdits } from './code-ipc';
import { codeWorkspace } from './workspace.svelte';

/** Put the files back as they were before the last edits, or apply those edits again. */
export async function restoreCodeEdits(chat: Pick<ChatSession, 'id' | 'projectId' | 'codeAgent'>, action: 'undo' | 'redo'): Promise<void> {
  await codeStore.ensureSession(chat.id);
  const result = await codeEdits(chat.id, action);
  if (!result.ok) throw new Error(result.error || 'Could not restore files.');
  await codeStore.refreshCheckpoints(chat.id);
  const project = codeStore.projectById(chat.projectId ?? null);
  if (project) await codeWorkspace.refreshChanges({ chatId: chat.id, projectRoot: project.rootPath, sessionId: chat.codeAgent?.sessionId || undefined });
  toastStore.success(`${action === 'undo' ? 'Restored' : 'Reapplied'} ${result.files?.length ?? 0} files`);
}
