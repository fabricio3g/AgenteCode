import type { IpcMain } from 'electron';

type TokenHandlerDeps = {
  ipcMain: IpcMain;
  countTokens: (text: string, baseUrl?: string) => unknown;
  buildContextBudget: (config: unknown, messages: unknown) => unknown;
  truncateMessages: (messages: unknown, budget: unknown) => unknown;
};

export function registerTokenHandlers({
  ipcMain,
  countTokens,
  buildContextBudget,
  truncateMessages,
}: TokenHandlerDeps): void {
  ipcMain.handle('count_tokens', (_e, { text, baseUrl }) => countTokens(text, baseUrl));
  ipcMain.handle('build_context_budget', (_e, { config, messages }) => buildContextBudget(config, messages));
  ipcMain.handle('truncate_messages', (_e, { messages, budget }) => truncateMessages(messages, budget));
}
