import type { IndexedDocument, QueryResponse } from '$lib/types/tauri';
import { invoke } from './tauri';

function requireChatId(chatId: string): string {
  const value = String(chatId || '').trim();
  if (!value) throw new Error('chat_id is required');
  return value;
}

export async function ingestDocument(payload: {
  file_path: string;
  chat_id: string;
  chunk_size?: number;
  overlap?: number;
}): Promise<IndexedDocument> {
  return invoke<IndexedDocument>('ingest_document', { payload: { ...payload, chat_id: requireChatId(payload.chat_id) } });
}

export async function ingestText(payload: {
  source: string;
  text: string;
  chat_id: string;
  file_type?: string;
  chunk_size?: number;
  overlap?: number;
}): Promise<IndexedDocument> {
  return invoke<IndexedDocument>('ingest_text', { payload: { ...payload, chat_id: requireChatId(payload.chat_id) } });
}

export async function ingestTextFast(payload: {
  source: string;
  text: string;
  chat_id: string;
  file_type?: string;
  chunk_size?: number;
  overlap?: number;
}): Promise<IndexedDocument> {
  return invoke<IndexedDocument>('ingest_text_fast', { payload: { ...payload, chat_id: requireChatId(payload.chat_id) } });
}

export async function queryDocuments(payload: {
  query: string;
  chat_id: string;
  top_k?: number;
}): Promise<QueryResponse> {
  return invoke<QueryResponse>('query_documents', { payload: { ...payload, chat_id: requireChatId(payload.chat_id) } });
}

export async function listRagDocuments(chat_id: string): Promise<IndexedDocument[]> {
  return invoke<IndexedDocument[]>('list_rag_documents', { payload: { chat_id: requireChatId(chat_id) } });
}

export async function removeRagDocument(doc_id: string, chat_id: string): Promise<boolean> {
  return invoke<boolean>('remove_rag_document', { docId: doc_id, payload: { chat_id: requireChatId(chat_id) } });
}

export async function clearRagDocuments(chat_id: string): Promise<void> {
  await invoke<void>('clear_rag_documents', { payload: { chat_id: requireChatId(chat_id) } });
}

async function hasRagDocuments(chat_id: string): Promise<boolean> {
  return invoke<boolean>('has_rag_documents', { payload: { chat_id: requireChatId(chat_id) } });
}
