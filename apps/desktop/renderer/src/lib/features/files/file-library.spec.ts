import { describe, expect, it } from 'vitest';
import type { ChatSession } from '$lib/types/chat';
import { applyRegistry, collectFiles, fileGroupOf, filterFiles, registryIndex, totalBytes, unusedFiles } from './file-library';

function chats(): ChatSession[] {
  return [
    {
      id: 'chat-a',
      title: 'Taxes',
      updatedAt: 10,
      messages: [
        {
          id: 'm1', role: 'user', content: 'see', createdAt: 100,
          attachments: [
            { id: 'a1', name: 'receipt.png', size: 2000, type: 'image/png', kind: 'image' },
            { id: 'a2', name: 'Return 2025.PDF', size: 5000, type: 'application/pdf', kind: 'document', ocrText: 'adjusted gross income' }
          ]
        },
        { id: 'm2', role: 'assistant', content: 'ok', createdAt: 101 }
      ]
    },
    {
      id: 'chat-b',
      title: 'Planning',
      updatedAt: 20,
      messages: [
        { id: 'm3', role: 'user', content: 'deck', createdAt: 300, attachments: [{ id: 'a3', name: 'q3.pptx', size: 1000, type: '' }] }
      ]
    }
  ] as ChatSession[];
}

describe('file library', () => {
  it('groups by MIME for images and by extension otherwise', () => {
    expect(fileGroupOf({ name: 'x.bin', type: 'image/webp' })).toBe('images');
    expect(fileGroupOf({ name: 'Report.DOCX', type: '' })).toBe('documents');
    expect(fileGroupOf({ name: 'data.csv', type: 'text/csv' })).toBe('spreadsheets');
    expect(fileGroupOf({ name: 'notes', type: 'text/plain' })).toBe('text');
    expect(fileGroupOf({ name: 'archive.zip', type: 'application/zip' })).toBe('other');
  });

  it('lists every attachment across chats, newest first, with its chat and message', () => {
    const entries = collectFiles(chats());
    expect(entries.map((e) => e.attachment!.id)).toEqual(['a3', 'a1', 'a2']);
    expect(entries[0]).toMatchObject({ chatId: 'chat-b', chatTitle: 'Planning', messageId: 'm3', group: 'presentations', key: 'chat-b:m3:a3', origin: 'uploaded' });
  });

  it('filters by group and searches name, chat title and extracted text', () => {
    const entries = collectFiles(chats());
    expect(filterFiles(entries, '', 'pdfs').map((e) => e.attachment!.id)).toEqual(['a2']);
    expect(filterFiles(entries, 'gross income', 'all').map((e) => e.attachment!.id)).toEqual(['a2']);
    expect(filterFiles(entries, 'planning', 'all').map((e) => e.attachment!.id)).toEqual(['a3']);
    expect(filterFiles(entries, 'planning', 'images')).toEqual([]);
  });

  it('sums sizes', () => {
    expect(totalBytes(collectFiles(chats()))).toBe(8000);
  });

  it('lists Code uploads and the documents the Code agent created, not its source edits', () => {
    const code = {
      id: 'code-1',
      title: 'Build report',
      updatedAt: 1,
      projectId: 'p1',
      messages: [
        {
          id: 'u1', role: 'user', content: 'chart this', createdAt: 500,
          metadata: { codeAttachments: [{ name: 'shot.png', path: '/home/me/.agente/attachments/ab12.png', mime: 'image/png', kind: 'image', bytes: 300 }] }
        },
        {
          id: 'r1', role: 'assistant', content: 'done', createdAt: 501,
          agentSteps: [
            { id: 's1', type: 'tool', label: 'write', status: 'done', fileChanges: [{ path: 'out/report.pdf', kind: 'created' }, { path: 'src/main.ts', kind: 'created' }] },
            { id: 's2', type: 'tool', label: 'write', status: 'done', fileChanges: [{ path: 'README.md', kind: 'modified' }, { path: 'tmp.csv', kind: 'created' }] },
            { id: 's3', type: 'tool', label: 'shell', status: 'done', fileChanges: [{ path: 'tmp.csv', kind: 'deleted' }] }
          ]
        }
      ]
    } as unknown as ChatSession;

    const entries = collectFiles([code], (chat) => (chat.id === 'code-1' ? '/work/proj' : null));
    expect(entries.map((e) => [e.origin, e.name, e.path])).toEqual([
      ['created', 'report.pdf', '/work/proj/out/report.pdf'],
      ['uploaded', 'shot.png', '/home/me/.agente/attachments/ab12.png']
    ]);
    expect(entries[0]).toMatchObject({ group: 'pdfs', projectRoot: '/work/proj', size: null });
    expect(filterFiles(entries, '', 'all', 'created').map((e) => e.name)).toEqual(['report.pdf']);
  });

  it('skips relative created paths when the project root is unknown', () => {
    const code = {
      id: 'c', title: 'x', updatedAt: 1,
      messages: [{ id: 'r', role: 'assistant', content: '', createdAt: 1, agentSteps: [{ id: 's', type: 'tool', label: 'w', status: 'done', fileChanges: [{ path: 'a.pdf', kind: 'created' }, { path: '/abs/b.docx', kind: 'created' }] }] }]
    } as unknown as ChatSession;
    expect(collectFiles([code]).map((e) => e.path)).toEqual(['/abs/b.docx']);
  });

  it('brings the registry row onto the attachment it belongs to', () => {
    // The persisted attachment row has no hash column, so the row is matched by
    // name and size — the pair that identifies the file for the screen.
    const entries = applyRegistry(collectFiles(chats()), registryIndex([
      { hash: 'h1', name: 'Return 2025.PDF', bytes: 5000, pinned: true, extractStatus: 'ready', storedPath: '/store/abc123.pdf' },
      { hash: 'h2', name: 'q3.pptx', bytes: 1000, pinned: false, extractStatus: 'keyword-only', storedPath: null },
      { hash: 'h3', name: 'receipt.png', bytes: 999, pinned: false, extractStatus: 'ready', storedPath: null }
    ]));

    const pdf = entries.find((entry) => entry.name === 'Return 2025.PDF')!;
    expect(pdf).toMatchObject({ hash: 'h1', pinned: true, extractStatus: 'ready', storedPath: '/store/abc123.pdf' });
    expect(entries.find((entry) => entry.name === 'q3.pptx')).toMatchObject({ hash: 'h2', extractStatus: 'keyword-only' });
    // A size that disagrees is a different file: no hash is attached to it.
    expect(entries.find((entry) => entry.name === 'receipt.png')!.hash).toBeUndefined();
  });

  it('calls a stored file unused only when no chat carries it and it is not pinned', () => {
    const entries = collectFiles(chats());
    const files = [
      { hash: 'h1', name: 'Return 2025.PDF', bytes: 5000, pinned: false, extractStatus: 'ready', storedPath: null },
      { hash: 'h2', name: 'gone.pdf', bytes: 4000, pinned: false, extractStatus: 'ready', storedPath: null },
      { hash: 'h3', name: 'kept.pdf', bytes: 3000, pinned: true, extractStatus: 'ready', storedPath: null }
    ];
    expect(unusedFiles(entries, files).map((file) => file.hash)).toEqual(['h2']);
  });
});
