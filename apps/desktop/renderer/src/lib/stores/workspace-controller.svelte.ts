import type { AppConfig, Attachment, ChatSession, WorkspaceFile } from '$lib/types/chat';
import type { IndexedDocument } from '$lib/types/bridge';
import { isElectron } from '$lib/services/bridge';
import { hasConfiguredVisionModel } from '$lib/services/chat-api';
import { ingestAttachment } from '$lib/services/attachment-ingestion';
import {
  createWorkspaceDocument,
  createWorkspaceFolder,
  deleteWorkspaceFile,
  indexWorkspaceFolder,
  openWorkspaceFile,
  pickWorkspaceFolder as pickWorkspaceFolderDialog,
  readWorkspaceFile,
  renameWorkspaceFile,
  writeTempFile
} from '$lib/services/files';
import {
  clearRagDocuments,
  ingestDocument,
  ingestText,
  listRagDocuments,
  removeRagDocument
} from '$lib/services/rag';
import { ingestionFileType } from '$shared/document-ingestion';
import { toastStore } from '$lib/stores/toast.svelte';
import { toErrorMessage } from '$lib/utils/errors';
import { countOf } from '$lib/utils/format';
import { createId } from '$lib/utils/id';
import {
  buildWorkspaceFromIndexResult,
  getWorkspaceExtension,
  getWorkspacePath,
  isSupportedWorkspaceFile,
  recalculateWorkspace,
  shouldIgnoreWorkspacePath,
  trimWorkspaceText
} from '$lib/stores/app-store-workspace';
import {
  WORKSPACE_MAX_FILES,
  WORKSPACE_MAX_FILE_SIZE_BYTES,
  normalizeContextMode,
  readBlobAsDataUrl
} from '$lib/stores/app-store-helpers';

export interface WorkspaceHost {
  getCurrentChatId: () => string | null;
  findChat: (chatId: string | null | undefined) => ChatSession | null;
  configForChat: (chat: ChatSession) => AppConfig;
  getPendingAttachments: () => Attachment[];
  setPendingAttachments: (items: Attachment[]) => void;
  setError: (error: string | null) => void;
  touchChats: () => void;
  persist: () => void;
}

/**
 * Workspace folder & per-chat RAG document management, delegated from
 * `AppStore` so all existing callers continue using `appStore.*` transparently.
 */
export class WorkspaceController {
  indexing = $state(false);
  ragDocumentsByChat = $state<Record<string, IndexedDocument[]>>({});
  private host: WorkspaceHost;

  constructor(host: WorkspaceHost) {
    this.host = host;
  }

  deleteChatRag(chatId: string) {
    delete this.ragDocumentsByChat[chatId];
  }

  async refreshRagDocuments(chatId = this.host.getCurrentChatId() || '') {
    if (!isElectron() || !chatId) return;
    try {
      const docs = await listRagDocuments(chatId);
      this.ragDocumentsByChat = {
        ...this.ragDocumentsByChat,
        [chatId]: docs
      };
    } catch {
      this.ragDocumentsByChat = {
        ...this.ragDocumentsByChat,
        [chatId]: []
      };
    }
  }

  async clearRag() {
    const targetChatId = this.host.getCurrentChatId();
    const targetChat = this.host.findChat(targetChatId);
    if (!isElectron() || !targetChatId || !targetChat) return;
    await clearRagDocuments(targetChatId);
    this.host.setPendingAttachments([]);
    // Clear workspace files but never demote Work → Chat
    if (targetChat.workspace && normalizeContextMode(targetChat.contextMode) === 'code') {
      targetChat.workspace = null;
      this.host.touchChats();
      this.host.persist();
    }
    await this.refreshRagDocuments(targetChatId);
  }

  documentStillReferenced(chatId: string, docId: string): boolean {
    const chat = this.host.findChat(chatId);
    return (this.host.getCurrentChatId() === chatId && this.host.getPendingAttachments().some((item) => item.docId === docId))
      || !!chat?.messages.some((message) => message.attachments?.some((item) => item.docId === docId))
      || !!chat?.workspace?.files.some((file) => file.docId === docId);
  }

  removeAttachment(attachmentId: string) {
    const pending = this.host.getPendingAttachments();
    const attachment = pending.find((a) => a.id === attachmentId);
    this.host.setPendingAttachments(pending.filter((a) => a.id !== attachmentId));
    if (attachment?.preview?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.preview);
    }
    const currentChatId = this.host.getCurrentChatId();
    if (attachment?.docId && isElectron() && currentChatId && !this.documentStillReferenced(currentChatId, attachment.docId)) {
      removeRagDocument(attachment.docId, currentChatId).catch(() => {});
      this.refreshRagDocuments().catch(() => {});
    }
  }

  async removeRagDoc(docId: string) {
    const currentChatId = this.host.getCurrentChatId();
    if (!isElectron() || !currentChatId) return;
    await removeRagDocument(docId, currentChatId);
    this.host.setPendingAttachments(this.host.getPendingAttachments().filter((attachment) => attachment.docId !== docId));
    const currentChat = this.host.findChat(currentChatId);
    if (currentChat?.workspace) {
      const nextFiles = currentChat.workspace.files.filter((file) => file.docId !== docId);
      if (nextFiles.length !== currentChat.workspace.files.length) {
        currentChat.workspace = nextFiles.length
          ? recalculateWorkspace({
              ...currentChat.workspace,
              files: nextFiles
            })
          : null;
        this.host.touchChats();
        this.host.persist();
      }
    }
    await this.refreshRagDocuments();
  }

  async addFiles(files: File[]) {
    const targetChatId = this.host.getCurrentChatId();
    if (!files.length || !targetChatId) return;

    const attachments: Attachment[] = files.map((file) => {
      const { kind, mime } = ingestionFileType(file.name, file.type);
      return {
        id: createId('attachment'), name: file.name, size: file.size, type: mime,
        kind: kind === 'image' ? 'image' : 'document', status: 'processing',
        processingMode: kind === 'audio' || kind === 'video' ? 'transcription' : kind === 'image' ? 'ocr' : 'document_text'
      };
    });
    this.host.setPendingAttachments([...this.host.getPendingAttachments(), ...attachments]);
    const uploadConfig = this.host.configForChat(this.host.findChat(targetChatId)!);
    for (let i = 0; i < files.length; i++) {
      const result = await ingestAttachment(files[i], { ...attachments[i] }, targetChatId, {
        visionAvailable: () => hasConfiguredVisionModel(uploadConfig),
        dataUrl: readBlobAsDataUrl,
        writeFile: (name, bytes) => writeTempFile(`${Date.now()}_${name}`, bytes),
        ingest: ingestDocument,
        extractFallback: async (file) => (await import('$lib/services/ocr')).extractFileContent(file)
      });
      if (this.host.getCurrentChatId() === targetChatId) {
        if (!this.host.getPendingAttachments().some((item) => item.id === result.id) && result.docId && !this.documentStillReferenced(targetChatId, result.docId)) {
          await removeRagDocument(result.docId, targetChatId);
        }
        await this.refreshRagDocuments(targetChatId);
        this.host.setPendingAttachments(this.host.getPendingAttachments().map((item) => item.id === result.id ? result : item));
      }
    }

    await this.refreshRagDocuments(targetChatId);
  }

  private async clearWorkspaceDocs(chatId = this.host.getCurrentChatId() || '') {
    const chat = this.host.findChat(chatId);
    if (!chatId || !chat?.workspace?.files?.length) return;
    await Promise.allSettled(
      chat.workspace.files
        .map((file) => file.docId)
        .filter((docId): docId is string => !!docId)
        .map((docId) => removeRagDocument(docId, chatId))
    );
  }

  async pickWorkspaceFolder() {
    const targetChatId = this.host.getCurrentChatId();
    const targetChat = this.host.findChat(targetChatId);
    if (!isElectron() || !targetChatId || !targetChat) return;
    if (normalizeContextMode(targetChat.contextMode) !== 'code') {
      toastStore.info('Switch to the Code tab to attach a folder.', 2800);
      return;
    }
    const selectedPath = await pickWorkspaceFolderDialog();
    if (!selectedPath) return;

    this.indexing = true;
    this.host.setError(null);

    try {
      await this.clearWorkspaceDocs(targetChatId);
      const result = await indexWorkspaceFolder(selectedPath, targetChatId);
      const chat = this.host.findChat(targetChatId);
      if (!chat) return;
      chat.workspace = buildWorkspaceFromIndexResult(result, Date.now());
      this.host.touchChats();
      this.host.persist();
      await this.refreshRagDocuments(targetChatId);
      toastStore.success(
        result.indexed_count > 0
          ? `Workspace ready: ${countOf(result.indexed_count, 'file')} indexed`
          : 'Workspace attached, but no files could be indexed.'
      );
    } finally {
      this.indexing = false;
    }
  }

  async addWorkspaceFolder(files: File[]) {
    if (!isElectron()) {
      toastStore.error('Work mode is only available in the desktop app.');
      return;
    }
    const targetChatId = this.host.getCurrentChatId();
    const targetChat = this.host.findChat(targetChatId);
    if (!files.length || !targetChatId || !targetChat) return;
    if (normalizeContextMode(targetChat.contextMode) !== 'code') {
      toastStore.info('Switch to the Code tab to attach a folder.', 2800);
      return;
    }

    this.indexing = true;
    this.host.setError(null);
    try {
      await this.clearWorkspaceDocs(targetChatId);

      const sortedFiles = [...files].sort((left, right) => getWorkspacePath(left).localeCompare(getWorkspacePath(right)));
      const workspaceFiles: WorkspaceFile[] = [];
      let indexedCount = 0;
      let skippedCount = 0;
      let indexedSoFar = 0;

      for (const file of sortedFiles) {
        const relativePath = getWorkspacePath(file);
        if (!relativePath || shouldIgnoreWorkspacePath(relativePath)) {
          skippedCount += 1;
          continue;
        }

        const workspaceFile: WorkspaceFile = {
          path: relativePath,
          name: file.name,
          size: file.size,
          type: getWorkspaceExtension(relativePath),
          status: 'ready'
        };

        if (!isSupportedWorkspaceFile(relativePath)) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'Unsupported file type';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        if (file.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'File too large';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        if (indexedSoFar >= WORKSPACE_MAX_FILES) {
          workspaceFile.status = 'skipped';
          workspaceFile.reason = 'Workspace file limit reached';
          skippedCount += 1;
          workspaceFiles.push(workspaceFile);
          continue;
        }

        try {
          const text = trimWorkspaceText(await file.text());
          if (!text) {
            workspaceFile.status = 'skipped';
            workspaceFile.reason = 'Empty text content';
            skippedCount += 1;
          } else {
            const doc = await ingestText({
              source: relativePath,
              text,
              chat_id: targetChatId,
              file_type: workspaceFile.type
            });
            workspaceFile.docId = doc.id;
            indexedCount += 1;
            indexedSoFar += 1;
          }
        } catch (error) {
          workspaceFile.status = 'error';
          workspaceFile.reason = toErrorMessage(error) || 'Failed to index file';
          skippedCount += 1;
        }

        workspaceFiles.push(workspaceFile);
      }

      const rootName = workspaceFiles[0]?.path.split('/')[0] || sortedFiles[0]?.name || 'Workspace';
      const chat = this.host.findChat(targetChatId);
      if (!chat) return;
      chat.workspace = {
        rootName,
        rootPath: undefined,
        attachedAt: Date.now(),
        fileCount: workspaceFiles.length,
        indexedCount,
        skippedCount,
        files: workspaceFiles
      };
      this.host.touchChats();
      this.host.persist();
      await this.refreshRagDocuments(targetChatId);

      toastStore.success(
        indexedCount > 0
          ? `Workspace ready: ${countOf(indexedCount, 'file')} indexed`
          : 'Workspace attached, but no files could be indexed.'
      );
    } finally {
      this.indexing = false;
    }
  }

  async clearWorkspace() {
    const targetChatId = this.host.getCurrentChatId();
    const targetChat = this.host.findChat(targetChatId);
    if (!targetChatId || !targetChat?.workspace) return;
    const docIds = targetChat.workspace.files
      .map((file) => file.docId)
      .filter((docId): docId is string => !!docId);
    await Promise.allSettled(docIds.map((docId) => removeRagDocument(docId, targetChatId)));
    targetChat.workspace = null;
    this.host.touchChats();
    this.host.persist();
    await this.refreshRagDocuments(targetChatId);
    toastStore.info('Workspace removed from this work session.', 2200);
  }

  /** Re-scan the workspace folder after LLM creates new files */
  async refreshWorkspace(chatId = this.host.getCurrentChatId() || '') {
    const chat = this.host.findChat(chatId);
    const rootPath = chat?.workspace?.rootPath;
    if (!rootPath || !chatId || !isElectron()) return;
    this.indexing = true;
    try {
      await this.clearWorkspaceDocs(chatId);
      const result = await indexWorkspaceFolder(rootPath, chatId);
      chat!.workspace = buildWorkspaceFromIndexResult(result, chat!.workspace!.attachedAt);
      this.host.touchChats();
      this.host.persist();
      await this.refreshRagDocuments(chatId);
    } finally {
      this.indexing = false;
    }
  }

  private requireCurrentWorkspace(): { chatId: string; rootPath: string } {
    const chatId = this.host.getCurrentChatId() || '';
    const rootPath = this.host.findChat(chatId)?.workspace?.rootPath;
    if (!rootPath) throw new Error('No workspace attached');
    return { chatId, rootPath };
  }

  async createWorkspaceFile(relativePath: string, docType: string, content: string): Promise<string> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    const fullPath = await createWorkspaceDocument(rootPath, relativePath, docType, content);
    await this.refreshWorkspace(chatId);
    return fullPath;
  }

  async renameWorkspaceFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    await renameWorkspaceFile(rootPath, oldRelPath, newRelPath);
    await this.refreshWorkspace(chatId);
    toastStore.info(`Renamed to ${newRelPath.split('/').pop()}`, 2000);
  }

  async deleteWorkspaceFile(relativePath: string): Promise<void> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    await deleteWorkspaceFile(rootPath, relativePath);
    await this.refreshWorkspace(chatId);
    toastStore.info(`Deleted ${relativePath.split('/').pop()}`, 2000);
  }

  async readWorkspaceFile(relativePath: string): Promise<string> {
    const { rootPath } = this.requireCurrentWorkspace();
    return readWorkspaceFile(rootPath, relativePath);
  }

  async openWorkspaceFile(relativePath: string): Promise<void> {
    const { rootPath } = this.requireCurrentWorkspace();
    const fullPath = `${rootPath}/${relativePath}`;
    await openWorkspaceFile(fullPath, rootPath);
  }

  async createWorkspaceFolder(relativePath: string): Promise<void> {
    const { chatId, rootPath } = this.requireCurrentWorkspace();
    await createWorkspaceFolder(rootPath, relativePath);
    await this.refreshWorkspace(chatId);
    toastStore.info(`Folder created`, 2000);
  }
}
