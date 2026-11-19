import { BrowserWindow, type IpcMain } from 'electron';

type ChatHandlerDeps = {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  completeChatRequest: (args: unknown) => unknown;
  startChatStream: (args: unknown, win: BrowserWindow | null) => unknown;
  cancelChatStream: (args: unknown) => unknown;
};

export function registerChatHandlers({
  ipcMain,
  getMainWindow,
  completeChatRequest,
  startChatStream,
  cancelChatStream,
}: ChatHandlerDeps): void {
  ipcMain.handle('chat_complete', (_e, args) => completeChatRequest(args));
  ipcMain.handle('chat_stream_start', (event, args) => startChatStream(args, BrowserWindow.fromWebContents(event.sender) ?? getMainWindow()));
  ipcMain.handle('chat_stream_cancel', (_e, args) => cancelChatStream(args));
}
