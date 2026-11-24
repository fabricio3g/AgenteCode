import type { IpcMain } from 'electron';

type RagHandlerDeps = {
  ipcMain: IpcMain;
  ingestDocument: (payload: unknown) => unknown;
  readIngestedDocument: (payload: { chat_id: string; doc_id: string }) => unknown;
  ingestText: (payload: unknown) => unknown;
  ingestTextFast: (payload: unknown) => unknown;
  queryDocuments: (payload: unknown) => unknown;
  listRagDocuments: (chatId: string) => unknown;
  removeRagDocument: (docId: string, chatId: string) => unknown;
  clearRagDocuments: (chatId: string) => unknown;
};

export function registerRagHandlers({
  ipcMain,
  ingestDocument,
  readIngestedDocument,
  ingestText,
  ingestTextFast,
  queryDocuments,
  listRagDocuments,
  removeRagDocument,
  clearRagDocuments,
}: RagHandlerDeps): void {
  ipcMain.handle('ingest_document', (_e, { payload }) => ingestDocument(payload));
  ipcMain.handle('read_ingested_document', (_e, { payload }) => readIngestedDocument(payload));
  ipcMain.handle('ingest_text', (_e, { payload }) => ingestText(payload));
  ipcMain.handle('ingest_text_fast', (_e, { payload }) => ingestTextFast(payload));
  ipcMain.handle('query_documents', (_e, { payload }) => queryDocuments(payload));
  ipcMain.handle('list_rag_documents', (_e, { payload }) => listRagDocuments(payload.chat_id));
  ipcMain.handle('remove_rag_document', (_e, { docId, payload }) => removeRagDocument(docId, payload.chat_id));
  ipcMain.handle('clear_rag_documents', (_e, { payload }) => clearRagDocuments(payload.chat_id));
}
