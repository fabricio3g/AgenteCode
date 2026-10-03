// ── The explorer's "open in editor" ────────────────────────────────────
// One place decides what opening a file means: ask the main process for the
// editor invocation, then either let it launch (it already has) or, for a
// terminal editor like nvim, run the command in the app's own terminal.
//
// Success is deliberately silent. An editor window appearing is its own
// feedback, and a toast for it would be noise on every row click.

import { openInEditor } from '../code-ipc';
import { codeWorkspace } from '../workspace.svelte';
import { appStore } from '$lib/stores/app.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

/** Run the terminal-editor command in a fresh terminal at the project root. */
async function runInTerminal(request: { command: string; cwd: string }): Promise<void> {
  const tab = await codeWorkspace.newTerminal(request.cwd);
  codeWorkspace.writeTerminal(tab.id, request.command + '\n');
}

export async function openFileInEditor(projectRoot: string, path: string, line?: number): Promise<void> {
  if (!projectRoot || !path) return;
  const editor = (appStore.config.ui?.editor ?? '').trim();
  try {
    const result = await openInEditor({ projectRoot, path, ...(line ? { line } : {}), ...(editor ? { editor } : {}) });
    if (result.terminal) {
      await runInTerminal(result.terminal);
      return;
    }
    if (!result.ok) toastStore.error(result.error || 'Could not open the editor.');
  } catch (error) {
    toastStore.error(String(error));
  }
}
