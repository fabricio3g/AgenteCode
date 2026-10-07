// Every file across the user's chats, flattened for the Files screen: what they
// uploaded (Home attachments, Code media) and the documents the Code agent made.

import type { Attachment, ChatSession } from '$lib/types/chat';

export type FileGroup = 'images' | 'pdfs' | 'documents' | 'spreadsheets' | 'presentations' | 'text' | 'media' | 'other';
export type FileOrigin = 'uploaded' | 'created';
/** Newest first is the order files arrive, so it is the default. */
export type FileSort = 'recent' | 'name' | 'size';
export const FILE_SORTS: readonly FileSort[] = ['recent', 'name', 'size'];

export const FILE_GROUPS: readonly FileGroup[] = ['images', 'pdfs', 'documents', 'spreadsheets', 'presentations', 'text', 'media', 'other'];

export interface FileEntry {
  key: string;
  origin: FileOrigin;
  name: string;
  /** Bytes, when known — created files are only sized once the disk is asked. */
  size: number | null;
  group: FileGroup;
  chatId: string;
  chatTitle: string;
  messageId: string;
  createdAt: number;
  /** A Home upload: lives inline on its message. */
  attachment?: Attachment;
  /** Absolute path on disk: a Code upload's stored copy, or a file the agent created. */
  path?: string;
  /** Project the created file belongs to; open/reveal/trash are confined to it. */
  projectRoot?: string;
  /** Text extracted from the file, searched along with its name. */
  text?: string;
  /** Registry row for this file, when one matches (see `applyRegistry`). */
  hash?: string;
  storedPath?: string;
  pinned?: boolean;
  extractStatus?: string;
}

/** The part of a registry row the screen needs. */
export interface StoredFileInfo {
  hash: string;
  name: string;
  bytes: number;
  pinned: boolean;
  extractStatus: string;
  storedPath?: string | null;
}

const EXTENSION_GROUP: Record<string, FileGroup> = {
  pdf: 'pdfs',
  doc: 'documents', docx: 'documents', odt: 'documents', rtf: 'documents', html: 'documents', htm: 'documents',
  xls: 'spreadsheets', xlsx: 'spreadsheets', xlsm: 'spreadsheets', ods: 'spreadsheets', csv: 'spreadsheets', tsv: 'spreadsheets',
  ppt: 'presentations', pptx: 'presentations', odp: 'presentations', key: 'presentations',
  png: 'images', jpg: 'images', jpeg: 'images', gif: 'images', webp: 'images', svg: 'images', bmp: 'images',
  mp3: 'media', wav: 'media', m4a: 'media', ogg: 'media', flac: 'media', aac: 'media', mp4: 'media', mov: 'media', webm: 'media',
  txt: 'text', md: 'text', markdown: 'text', json: 'text', jsonl: 'text', yaml: 'text', yml: 'text', xml: 'text', log: 'text',
  js: 'text', ts: 'text', py: 'text', rs: 'text', go: 'text', java: 'text', c: 'text', cpp: 'text', sh: 'text', sql: 'text'
};

/**
 * What the Code agent writes that counts as a *document*. Every source file it
 * touches would bury the PDF it made among a hundred `.ts` edits; those already
 * have the Changes pane.
 */
const CREATED_DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'ppt', 'pptx', 'odp',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp3', 'wav', 'mp4', 'webm', 'md', 'txt', 'html', 'htm'
]);

function extensionOf(name: string): string {
  return String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

function baseName(path: string): string {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function joinPath(root: string, relative: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${relative.replace(/^\.?[\\/]+/, '')}`;
}

/** The MIME type wins for images; everything else goes by extension, since browsers often report office files as ''. */
export function fileGroupOf(file: { name: string; type?: string; kind?: string }): FileGroup {
  const type = String(file.type || '');
  if (file.kind === 'image' || type.startsWith('image/')) return 'images';
  const byExtension = EXTENSION_GROUP[extensionOf(file.name)];
  if (byExtension) return byExtension;
  if (type.startsWith('audio/') || type.startsWith('video/') || file.kind === 'audio' || file.kind === 'video') return 'media';
  if (type === 'application/pdf' || file.kind === 'pdf') return 'pdfs';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * Newest first. An upload is listed once per message that carries it (each is
 * its own copy); a created file once per chat, at its latest write, and not at
 * all when the agent deleted it afterwards.
 */
export function collectFiles(chats: readonly ChatSession[], projectRootOf: (chat: ChatSession) => string | null = () => null): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const chat of chats) {
    const root = projectRootOf(chat);
    const created = new Map<string, FileEntry | null>();

    for (const message of chat.messages ?? []) {
      const createdAt = message.createdAt || chat.updatedAt || 0;
      const base = { chatId: chat.id, chatTitle: chat.title, messageId: message.id, createdAt };

      for (const attachment of message.attachments ?? []) {
        entries.push({
          ...base,
          key: `${chat.id}:${message.id}:${attachment.id}`,
          origin: 'uploaded',
          name: attachment.name,
          size: Number(attachment.size) || 0,
          group: fileGroupOf(attachment),
          attachment,
          text: attachment.ocrText
        });
      }

      for (const media of message.metadata?.codeAttachments ?? []) {
        entries.push({
          ...base,
          key: `${chat.id}:${message.id}:${media.path}`,
          origin: 'uploaded',
          name: media.name,
          size: Number(media.bytes) || 0,
          group: fileGroupOf({ name: media.name, type: media.mime, kind: media.kind }),
          path: media.path
        });
      }

      for (const step of message.agentSteps ?? []) {
        for (const change of step.fileChanges ?? []) {
          if (!change.path) continue;
          const absolute = isAbsolutePath(change.path) ? change.path : root ? joinPath(root, change.path) : null;
          if (!absolute) continue;
          if (change.kind === 'deleted') { created.set(absolute, null); continue; }
          const name = baseName(change.path);
          const known = created.get(absolute);
          // A file the agent only modified was not made here — unless this chat created it earlier.
          if (change.kind === 'modified' && !known) continue;
          if (!CREATED_DOCUMENT_EXTENSIONS.has(extensionOf(name))) continue;
          created.set(absolute, {
            ...base,
            key: `${chat.id}:created:${absolute}`,
            origin: 'created',
            name,
            size: null,
            group: fileGroupOf({ name }),
            path: absolute,
            projectRoot: root ?? undefined
          });
        }
      }
    }

    for (const entry of created.values()) if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * A registry row and the message attachment that carries it are matched by name
 * and size: the attachment row a chat persists has no hash column, and adding
 * one would mean another migration for a value the pair already identifies.
 */
export function registryKey(name: string, size: number | null): string {
  // An unknown size is its own key: a created file (never in the registry) must
  // not look like a stored 0-byte file of the same name.
  return `${String(name || '').toLowerCase()}:${size == null ? -1 : Number(size) || 0}`;
}

export function registryIndex(files: readonly StoredFileInfo[]): Map<string, StoredFileInfo> {
  const index = new Map<string, StoredFileInfo>();
  for (const file of files) index.set(registryKey(file.name, file.bytes), file);
  return index;
}

/** Copies registry state (hash, pin, extraction status) onto the rows it belongs to. */
export function applyRegistry(entries: readonly FileEntry[], index: Map<string, StoredFileInfo>): FileEntry[] {
  return entries.map((entry) => {
    const file = index.get(registryKey(entry.name, entry.size));
    if (!file) return entry;
    return {
      ...entry,
      hash: file.hash,
      storedPath: file.storedPath ?? undefined,
      pinned: !!file.pinned,
      extractStatus: file.extractStatus
    };
  });
}

/**
 * Registry rows the screen has no chat for: the file was uploaded once and every
 * chat that carried it is gone. Pinned rows are knowledge the user asked to keep,
 * so they are never "unused".
 */
export function unusedFiles(entries: readonly FileEntry[], files: readonly StoredFileInfo[]): StoredFileInfo[] {
  const held = new Set(entries.map((entry) => registryKey(entry.name, entry.size)));
  return files.filter((file) => !file.pinned && !held.has(registryKey(file.name, file.bytes)));
}

/** Search over file name, chat title and any text extracted from the file. */
export function filterFiles(entries: readonly FileEntry[], query: string, group: FileGroup | 'all', origin: FileOrigin | 'all' = 'all'): FileEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) =>
    (group === 'all' || entry.group === group)
    && (origin === 'all' || entry.origin === origin)
    && (!needle || `${entry.name} ${entry.chatTitle} ${entry.text ?? ''}`.toLowerCase().includes(needle))
  );
}

export function totalBytes(entries: readonly FileEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
}

/**
 * A new array in the requested order. Ties keep the newest-first order they
 * arrived in, and files whose size was never measured (the agent's own outputs)
 * sit at the end of a size sort instead of pretending to be empty.
 */
export function sortFiles(entries: readonly FileEntry[], sort: FileSort): FileEntry[] {
  const sorted = [...entries];
  if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  else if (sort === 'size') sorted.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
  return sorted;
}
