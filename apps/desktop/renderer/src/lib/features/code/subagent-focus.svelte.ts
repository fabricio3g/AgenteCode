/**
 * Which subagent each conversation's Subagent pane shows. The pill over the
 * composer writes it and the conversation's workspace reads it, so the two
 * never pass callbacks through CodeSurface. `at` makes picking the same child
 * again (after the pane was closed) a new request, so the pane reopens.
 */
class SubagentFocus {
  picked = $state<Record<string, { id: string; at: number }>>({});

  open(chatId: string, id: string): void {
    this.picked[chatId] = { id, at: Date.now() };
  }

  get(chatId: string): string | null {
    return this.picked[chatId]?.id ?? null;
  }
}

export const subagentFocus = new SubagentFocus();
