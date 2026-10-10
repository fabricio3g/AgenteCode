import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { runHomeTool, type HomeToolDeps, type HomeAttachment } from './agent-tool-home';
import { parseDelimited, tablesFromLines } from './agent-doc-reader';
import { convertTimeZone, convertUnits, dateMath } from './agent-units';
import { HOME_TOOL_GROUPS, filterEnabledTools, toggleGroup, toolGroupOf } from './agent-tool-registry';
import { getToolDefinitions } from './agent-tooling';
import type { ToolContext } from './agent-types';

const ctx = { chatId: 'c1', files: {}, executionMode: 'sandbox' } as ToolContext;

function deps(attachments: HomeAttachment[], over: Partial<HomeToolDeps> = {}): HomeToolDeps {
  return {
    attachments: () => attachments,
    readWorkspaceBinary: async () => new ArrayBuffer(0),
    dataUrlBytes: async (url) => new TextEncoder().encode(decodeURIComponent(url.split(',')[1])).buffer as ArrayBuffer,
    visionAvailable: async () => false,
    ocr: async () => 'ocr text',
    transcribe: async () => 'hello world',
    ...over
  };
}

describe('documents', () => {
  it('reads the saved OCR extraction instead of reparsing the original scan', async () => {
    const dataUrlBytes = vi.fn(async () => new ArrayBuffer(0));
    const d = deps([{ id: 'scan', name: 'scan.pdf', type: 'application/pdf', docId: 'indexed-scan', data: 'data:pdf,invalid' }], {
      dataUrlBytes,
      readIngested: async () => ({ text: '## Page 1\n\nFirst page\n\n## Page 2\n\nInvoice total 42', file_type: 'pdf', warning: 'Some visual content is unreadable' })
    });
    const result = await runHomeTool('read_document', { range: '2' }, ctx, d);
    expect(result?.success).toBe(true);
    expect(result?.output).toMatchObject({ returned: ['page 2'], warning: 'Some visual content is unreadable' });
    expect((result?.output as { content: string }).content).toContain('Invoice total 42');
    expect(dataUrlBytes).not.toHaveBeenCalled();
  });

  it('reads an indexed transcript as a source document and reuses it for transcription', async () => {
    const transcribe = vi.fn(async () => 'must not be called');
    const d = deps([{ id: 'audio', name: 'meeting.mp3', type: 'audio/mpeg', docId: 'transcript', data: 'data:audio,bytes' }], {
      transcribe, readIngested: async () => ({ text: '## Transcript 00:00:30\n\nDelivery date is Monday.', file_type: 'audio' })
    });
    expect((await runHomeTool('read_document', {}, ctx, d))?.success).toBe(true);
    expect((await runHomeTool('transcribe_audio', {}, ctx, d))?.output).toMatchObject({ source: 'meeting.mp3', text: '## Transcript 00:00:30\n\nDelivery date is Monday.' });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('reads CSV with sheet selection and extracts its table', async () => {
    const att = [{ id: 'a', name: 'sales.csv', type: 'text/csv', data: 'data:text/csv,a%2Cb%0A1%2C2%0A3%2C4' }];
    const read = await runHomeTool('read_document', {}, ctx, deps(att));
    expect(read?.success).toBe(true);
    expect((read?.output as { content: string }).content).toContain('1\t2');
    const tables = await runHomeTool('extract_tables', { source: 'sales.csv' }, ctx, deps(att));
    expect((tables?.output as { tables: Array<{ rows: string[][] }> }).tables[0].rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('truncates long text and points at the continuation', async () => {
    const body = 'x'.repeat(2000);
    const att = [{ id: 'a', name: 'n.txt', type: 'text/plain', data: `data:text/plain,${body}` }];
    const r = await runHomeTool('read_document', { max_chars: 500 }, ctx, deps(att));
    const out = r?.output as { content: string; truncated: boolean };
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(500);
  });

  it('continues inside a long document instead of repeating its first unit', async () => {
    const body = 'First part '.repeat(100) + 'Last source fact: 42.';
    const d = deps([{ id: 'long', name: 'long.txt', type: 'text/plain', docId: 'long' }], {
      readIngested: async () => ({ text: body, file_type: 'text' })
    });
    const first = (await runHomeTool('read_document', { max_chars: 500 }, ctx, d))?.output as { content: string; next_offset: number };
    const second = (await runHomeTool('read_document', { max_chars: 1000, offset: first.next_offset }, ctx, d))?.output as { content: string; truncated: boolean };
    expect(first.next_offset).toBe(500);
    expect(first.content + second.content).toBe(body);
    expect(second.truncated).toBe(false);
  });

  it('continues spreadsheet rows past the first output window', async () => {
    const csv = 'Row,Total\n' + Array.from({ length: 100 }, (_, i) => `${i + 1},${i + 1}`).join('\n');
    const d = deps([{ id: 'data', name: 'data.csv', type: 'text/csv', data: `data:text/csv,${encodeURIComponent(csv)}` }]);
    const first = (await runHomeTool('extract_tables', { max_rows: 60 }, ctx, d))?.output as { tables: Array<{ nextRowOffset: number }> };
    const second = (await runHomeTool('extract_tables', { max_rows: 60, row_offset: first.tables[0].nextRowOffset }, ctx, d))?.output as { tables: Array<{ rows: string[][]; rowsTruncated: boolean }> };
    expect(second.tables[0].rows.at(-1)).toEqual(['100', '100']);
    expect(second.tables[0].rowsTruncated).toBe(false);
  });

  it('reads docx paragraphs and tables', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    const d = deps([{ id: 'a', name: 'r.docx', type: '', data: 'data:x,' }], { dataUrlBytes: async () => bytes });
    const read = await runHomeTool('read_document', {}, ctx, d);
    expect((read?.output as { content: string }).content).toContain('Hello');
    const tables = await runHomeTool('extract_tables', {}, ctx, d);
    expect((tables?.output as { tables: Array<{ rows: string[][] }> }).tables[0].rows).toEqual([['A', 'B']]);
  });

  it('fails clearly with nothing attached', async () => {
    const r = await runHomeTool('read_document', {}, ctx, deps([]));
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/attach/i);
  });

  it('parses quoted CSV and detects pdf-like tables', () => {
    expect(parseDelimited('a,"b,c"\n1,2')).toEqual([['a', 'b,c'], ['1', '2']]);
    expect(tablesFromLines(['title', 'a\tb', 'c\td', 'text'])).toEqual([[['a', 'b'], ['c', 'd']]]);
  });
});

describe('media', () => {
  it('describe_image refuses without vision and returns the image with it', async () => {
    const att = [{ id: 'i', name: 'p.png', type: 'image/png', kind: 'image', base64: 'data:image/png;base64,QUJD' }];
    const no = await runHomeTool('describe_image', {}, ctx, deps(att));
    expect(no?.success).toBe(false);
    const yes = await runHomeTool('describe_image', {}, ctx, deps(att, { visionAvailable: async () => true }));
    expect(yes?.image).toEqual({ data: 'QUJD', mimeType: 'image/png' });
  });

  it('ocr and transcribe use their engines', async () => {
    const att = [
      { id: 'i', name: 'p.png', type: 'image/png', kind: 'image', base64: 'data:image/png;base64,QUJD' },
      { id: 'u', name: 'v.mp3', type: 'audio/mpeg', data: 'data:audio/mpeg;base64,QUJD' }
    ];
    const d = deps(att, { dataUrlBytes: async () => new ArrayBuffer(3) });
    expect((await runHomeTool('ocr_image', {}, ctx, d))?.output).toMatchObject({ text: 'ocr text' });
    expect((await runHomeTool('transcribe_audio', {}, ctx, d))?.output).toMatchObject({ text: 'hello world' });
  });
});

describe('productivity', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });

  it('notes persist and round-trip', async () => {
    const created = await runHomeTool('notes', { action: 'create', title: 'Idea', body: 'abc', tags: ['X'] }, ctx);
    const id = (created?.output as { note: { id: string } }).note.id;
    await runHomeTool('notes', { action: 'update', id, append: 'def' }, ctx);
    expect((await runHomeTool('notes', { action: 'read', id }, ctx))?.output).toMatchObject({ note: { body: 'abc\ndef', tags: ['x'] } });
    expect(((await runHomeTool('notes', { action: 'list', query: 'idea' }, ctx))?.output as { notes: unknown[] }).notes).toHaveLength(1);
    expect((await runHomeTool('notes', { action: 'delete', id }, ctx))?.success).toBe(true);
  });

  it('todos add, complete and filter', async () => {
    const added = await runHomeTool('todos', { action: 'add', text: 'milk' }, ctx);
    const id = (added?.output as { todo: { id: string } }).todo.id;
    await runHomeTool('todos', { action: 'complete', id }, ctx);
    expect(((await runHomeTool('todos', { action: 'list' }, ctx))?.output as { todos: unknown[] }).todos).toHaveLength(0);
    expect(((await runHomeTool('todos', { action: 'list', status: 'done' }, ctx))?.output as { todos: unknown[] }).todos).toHaveLength(1);
  });

  it('reminders set, list, fire and cancel', async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const { setReminderNotifier } = await import('./home-productivity');
    setReminderNotifier((r) => fired.push(r.text));
    const set = await runHomeTool('reminders', { action: 'set', text: 'tea', in_minutes: 1 }, ctx);
    expect(set?.success).toBe(true);
    expect(((await runHomeTool('reminders', { action: 'list' }, ctx))?.output as { reminders: unknown[] }).reminders).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    expect(fired).toEqual(['tea']);
    const second = await runHomeTool('reminders', { action: 'set', text: 'x', in_minutes: 5 }, ctx);
    const id = (second?.output as { reminder: { id: string } }).reminder.id;
    expect((await runHomeTool('reminders', { action: 'cancel', id }, ctx))?.success).toBe(true);
    vi.advanceTimersByTime(600_000);
    expect(fired).toEqual(['tea']);
    vi.useRealTimers();
  });
});

describe('conversions', () => {
  it('converts units', () => {
    expect(convertUnits(1, 'km', 'mi').result).toBeCloseTo(0.621371, 5);
    expect(convertUnits(100, 'c', 'f').result).toBe(212);
    expect(convertUnits(1, 'GiB', 'MB').result).toBeCloseTo(1073.741824, 5);
    expect(() => convertUnits(1, 'kg', 'km')).toThrow(/Cannot convert/);
  });

  it('converts time zones across DST and does date math', () => {
    const r = convertTimeZone('2026-03-01 14:30', 'America/New_York', ['Asia/Tokyo', 'UTC']);
    expect(r.to[0].local).toBe('2026-03-02 04:30');
    expect(r.to[1].local).toBe('2026-03-01 19:30');
    expect(dateMath({ start: '2026-01-01', end: '2026-01-31', zone: 'UTC' }).totalDays).toBe(30);
  });
});

describe('tool registry', () => {
  it('groups every offered Home tool and honours the disabled list', () => {
    const defs = getToolDefinitions('workspace', {}, 'work');
    const ungrouped = defs.map((d) => d.function.name).filter((n) => !toolGroupOf(n));
    expect(ungrouped).toEqual([]);
    expect(HOME_TOOL_GROUPS.map((g) => g.id)).toContain('productivity');
    const off = toggleGroup([], 'media', false);
    const names = getToolDefinitions('workspace', {}, 'work', off).map((d) => d.function.name);
    expect(names).not.toContain('ocr_image');
    expect(names).toContain('notes');
    expect(filterEnabledTools(defs, ['notes']).map((d) => d.function.name)).not.toContain('notes');
    expect(toggleGroup(off, 'media', true)).toEqual([]);
  });
});
