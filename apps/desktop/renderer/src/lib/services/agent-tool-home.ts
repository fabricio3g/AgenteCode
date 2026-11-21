/**
 * Handlers for the Home agent's document, productivity and media tools.
 *
 * Everything that touches the app (attachments, OCR, whisper, the workspace)
 * comes in through `HomeToolDeps`, so the logic here is testable on its own.
 */

import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import { docKindOf, parseDocument, parseIngestedDocument, selectUnits, type ParsedDocument } from '$lib/services/agent-doc-reader';
import { ingestionFileType } from '$shared/document-ingestion';
import { convertTimeZone, convertUnits, dateMath, supportedUnits } from '$lib/services/agent-units';
import * as productivity from '$lib/services/home-productivity';

export type HomeAttachment = { id: string; name: string; type: string; kind?: string; data?: string; base64?: string; ocrText?: string; docId?: string };

export interface HomeToolDeps {
  attachments: (chatId: string) => HomeAttachment[];
  /** Raw bytes of a workspace file. */
  readWorkspaceBinary: (root: string, path: string) => Promise<ArrayBuffer>;
  /** Bytes behind an attachment's `data:` URL. */
  dataUrlBytes: (dataUrl: string) => Promise<ArrayBuffer>;
  visionAvailable: () => Promise<boolean>;
  ocr: (name: string, type: string, bytes: ArrayBuffer) => Promise<string>;
  transcribe: (bytes: ArrayBuffer, mime: string) => Promise<string>;
  readIngested?: (chatId: string, docId: string) => Promise<{ text: string; file_type: string; warning?: string }>;
}

let defaultDepsFactory: (() => Promise<HomeToolDeps>) | null = null;

/**
 * Registers the app-wired dependency factory from the composition root so
 * `agent-tool-home.ts` stays a leaf with zero imports of the store layer.
 */
export function registerHomeToolDeps(factory: () => Promise<HomeToolDeps>): void {
  defaultDepsFactory = factory;
}

type Source = { name: string; type: string; bytes: ArrayBuffer; ocrText?: string; base64?: string; docId?: string };

type Want = 'document' | 'image' | 'audio';

const isImage = (a: HomeAttachment) => a.kind === 'image' || ingestionFileType(a.name, a.type).kind === 'image';
const isAudio = (a: HomeAttachment) => ['audio', 'video'].includes(ingestionFileType(a.name, a.type).kind);
const matches = (a: HomeAttachment, want: Want) =>
  want === 'image' ? isImage(a) : want === 'audio' ? isAudio(a) : !!a.docId || (!isImage(a) && !isAudio(a));

function mimeFor(name: string): string {
  return ingestionFileType(name).mime;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function stripDataUrl(value: string): string {
  return value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
}

async function resolveSource(args: Record<string, unknown>, ctx: ToolContext, deps: HomeToolDeps, want: Want): Promise<Source> {
  const requested = String(args.source ?? '').trim();
  const attached = deps.attachments(ctx.chatId);
  const candidates = attached.filter((a) => matches(a, want));
  let hit: HomeAttachment | undefined;
  if (requested) {
    const lower = requested.toLowerCase();
    hit = attached.find((a) => a.id === requested || a.name.toLowerCase() === lower) ?? attached.find((a) => a.name.toLowerCase().includes(lower));
  } else if (candidates.length === 1) {
    hit = candidates[0];
  } else if (candidates.length > 1) {
    // The most recent attachment is the one the user is talking about.
    hit = candidates[candidates.length - 1];
  }
  if (hit) {
    let bytes: ArrayBuffer | undefined;
    if (hit.docId && deps.readIngested && (want === 'document' || want === 'audio')) bytes = new ArrayBuffer(0);
    else if (hit.data) bytes = await deps.dataUrlBytes(hit.data);
    else if (hit.base64) bytes = base64ToBuffer(stripDataUrl(hit.base64));
    if (bytes || hit.ocrText) {
      return { name: hit.name, type: hit.type || mimeFor(hit.name), bytes: bytes ?? new TextEncoder().encode(hit.ocrText).buffer as ArrayBuffer, ocrText: hit.ocrText, base64: hit.base64 ? stripDataUrl(hit.base64) : undefined, docId: hit.docId };
    }
  }
  if (requested && ctx.executionMode === 'workspace' && ctx.workspaceRoot) {
    const bytes = await deps.readWorkspaceBinary(ctx.workspaceRoot, requested.replace(/^\.?\//, ''));
    return { name: requested, type: mimeFor(requested), bytes };
  }
  if (requested && requested in ctx.files) {
    return { name: requested, type: 'text/plain', bytes: new TextEncoder().encode(ctx.files[requested]).buffer as ArrayBuffer };
  }
  const names = candidates.map((a) => a.name);
  throw new Error(
    requested
      ? `No attached or workspace file matches "${requested}".${names.length ? ` Attached ${want}s: ${names.join(', ')}.` : ''}`
      : `No ${want} is attached to this chat. Ask the user to attach one, or pass a workspace path in source.`
  );
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

async function readDocument(args: Record<string, unknown>, ctx: ToolContext, deps: HomeToolDeps): Promise<ParsedDocument & { name: string }> {
  const source = await resolveSource(args, ctx, deps, 'document');
  if (source.docId && deps.readIngested) {
    const result = await deps.readIngested(ctx.chatId, source.docId);
    return { name: source.name, ...parseIngestedDocument(result.text, result.file_type), warning: result.warning };
  }
  if (source.ocrText) return { name: source.name, ...parseIngestedDocument(source.ocrText, docKindOf(source.name, source.type) || 'text') };
  if (!docKindOf(source.name, source.type)) {
    if (source.ocrText) return { name: source.name, kind: 'text', unitName: 'document', units: [{ label: 'document', text: source.ocrText, tables: [] }] };
    throw new Error(`Unsupported document type: ${source.name}. Supported: PDF, DOCX, XLSX, CSV, PPTX, TXT/MD.`);
  }
  try {
    return { name: source.name, ...(await parseDocument(source.name, source.bytes, source.type)) };
  } catch (err) {
    if (source.ocrText) return { name: source.name, kind: 'text', unitName: 'document', units: [{ label: 'document', text: source.ocrText, tables: [] }] };
    throw err;
  }
}

function readDocumentText(doc: ParsedDocument & { name: string }, range: unknown, maxChars: number, offset = 0) {
  const indexes = selectUnits(doc.units, range);
  const blocks = indexes.map((index) => ({ index, label: doc.units[index].label,
    text: doc.unitName === 'document' ? doc.units[index].text : `--- ${doc.units[index].label} ---\n${doc.units[index].text}` }));
  const text = blocks.map((block) => block.text).join('\n\n');
  const start = Math.max(0, offset), end = Math.min(text.length, start + maxChars);
  let cursor = 0;
  const returned: string[] = [];
  let stoppedAt: number | undefined;
  for (const block of blocks) {
    const blockEnd = cursor + block.text.length;
    if (blockEnd > start && cursor < end) returned.push(block.label);
    if (stoppedAt === undefined && blockEnd > end) stoppedAt = block.index + 1;
    cursor = blockEnd + 2;
  }
  return { content: text.slice(start, end), returned, truncated: end < text.length, stoppedAt,
    nextOffset: end < text.length ? end : undefined, total: doc.units.length, ...(doc.warning ? { warning: doc.warning } : {}) };
}

function tablesOf(doc: ParsedDocument, range: unknown, maxRows: number, budget = 9000, rowOffset = 0) {
  const out: Array<{ unit: string; index: number; columns: number; rowCount: number; rows: string[][]; rowsTruncated: boolean; rowOffset: number; nextRowOffset?: number }> = [];
  let chars = 0;
  let omitted = 0;
  for (const unitIndex of selectUnits(doc.units, range)) {
    const unit = doc.units[unitIndex];
    unit.tables.forEach((table, i) => {
      const rows = table.slice(rowOffset, rowOffset + maxRows);
      const size = JSON.stringify(rows).length;
      if (chars + size > budget && out.length) { omitted++; return; }
      chars += size;
      out.push({ unit: unit.label, index: i + 1, columns: Math.max(0, ...rows.map((r) => r.length)), rowCount: table.length, rows, rowsTruncated: table.length > rowOffset + rows.length, rowOffset, nextRowOffset: table.length > rowOffset + rows.length ? rowOffset + rows.length : undefined });
    });
  }
  return { tables: out, omitted };
}

const ok = (output: unknown, extra?: Partial<ToolResult>): ToolResult => ({ success: true, output, ...extra });
const fail = (error: string, note?: string): ToolResult => ({ success: false, error, ...(note ? { note } : {}) });

const HOME_EXTRA_TOOL_NAMES = new Set(['read_document', 'extract_tables', 'notes', 'todos', 'reminders', 'convert_units', 'convert_time', 'ocr_image', 'describe_image', 'transcribe_audio']);

function notesTool(args: Record<string, unknown>): ToolResult {
  const id = String(args.id ?? '');
  const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
  switch (String(args.action)) {
    case 'create': return ok({ note: productivity.createNote({ title: String(args.title ?? ''), body: args.body === undefined ? '' : String(args.body), tags }) });
    case 'list': return ok({ notes: productivity.listNotes({ query: args.query as string | undefined, tag: args.tag as string | undefined }) });
    case 'read': {
      const note = productivity.readNote(id);
      return note ? ok({ note }) : fail(`No note with id ${id}`);
    }
    case 'update': {
      const note = productivity.updateNote(id, {
        title: args.title === undefined ? undefined : String(args.title),
        body: args.body === undefined ? undefined : String(args.body),
        append: args.append === undefined ? undefined : String(args.append),
        tags
      });
      return note ? ok({ note }) : fail(`No note with id ${id}`);
    }
    case 'delete': return productivity.deleteNote(id) ? ok({ deleted: id }) : fail(`No note with id ${id}`);
    default: return fail('action must be create, list, read, update or delete');
  }
}

function todosTool(args: Record<string, unknown>): ToolResult {
  const id = String(args.id ?? '');
  switch (String(args.action)) {
    case 'add': return ok({ todo: productivity.addTodo({ text: String(args.text ?? ''), due: args.due ? String(args.due) : undefined }) });
    case 'list': return ok({ todos: productivity.listTodos({ status: (args.status as 'open' | 'done' | 'all') ?? 'open' }) });
    case 'complete':
    case 'reopen': {
      const todo = productivity.setTodoDone(id, args.action === 'complete');
      return todo ? ok({ todo }) : fail(`No to-do with id ${id}`);
    }
    case 'remove': return productivity.removeTodo(id) ? ok({ removed: id }) : fail(`No to-do with id ${id}`);
    default: return fail('action must be add, list, complete, reopen or remove');
  }
}

function remindersTool(args: Record<string, unknown>): ToolResult {
  switch (String(args.action)) {
    case 'set': {
      const reminder = productivity.setReminder({
        text: String(args.text ?? ''),
        at: args.at ? String(args.at) : undefined,
        inMinutes: args.in_minutes === undefined ? undefined : Number(args.in_minutes)
      });
      return ok({ reminder: { ...reminder, fires_at: new Date(reminder.fireAt).toISOString() }, note: 'Fires as an in-app notification while Agente is running.' });
    }
    case 'list': return ok({ reminders: productivity.listReminders().map((r) => ({ ...r, fires_at: new Date(r.fireAt).toISOString() })) });
    case 'cancel': return productivity.cancelReminder(String(args.id ?? '')) ? ok({ cancelled: args.id }) : fail(`No reminder with id ${args.id}`);
    default: return fail('action must be set, list or cancel');
  }
}

function timeTool(args: Record<string, unknown>): ToolResult {
  const datetime = args.datetime ? String(args.datetime) : undefined;
  const fromZone = args.from_zone ? String(args.from_zone) : undefined;
  if (args.end || args.add) {
    return ok(dateMath({ start: datetime, end: args.end ? String(args.end) : undefined, add: args.add as never, zone: fromZone }));
  }
  const zones = Array.isArray(args.to_zones) ? args.to_zones.map(String) : [];
  return ok(convertTimeZone(datetime, fromZone, zones));
}

export async function runHomeTool(name: string, args: Record<string, unknown>, ctx: ToolContext, deps?: HomeToolDeps): Promise<ToolResult | undefined> {
  if (!HOME_EXTRA_TOOL_NAMES.has(name)) return undefined;
  try {
    switch (name) {
      case 'notes': return notesTool(args);
      case 'todos': return todosTool(args);
      case 'reminders': return remindersTool(args);
      case 'convert_time': return timeTool(args);
      case 'convert_units': {
        try {
          return ok(convertUnits(Number(args.value), String(args.from ?? ''), String(args.to ?? '')));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err), `Supported units: ${JSON.stringify(supportedUnits())}`);
        }
      }
    }
    const d = deps ?? (defaultDepsFactory ? await defaultDepsFactory() : null);
    if (!d) throw new Error('Home tool dependencies have not been registered.');
    switch (name) {
      case 'read_document': {
        const doc = await readDocument(args, ctx, d);
        const r = readDocumentText(doc, args.range, clampInt(args.max_chars, 8000, 500, 10000), clampInt(args.offset, 0, 0, 10_000_000));
        return ok({
          source: doc.name, kind: doc.kind, unit: doc.unitName, total_units: r.total, returned: r.returned, truncated: r.truncated,
          content: r.content || '(no extractable text; a scanned PDF needs OCR on its page images)',
          ...(r.warning ? { warning: r.warning } : {}),
          ...(r.truncated ? { next_offset: r.nextOffset, next_step: `Output truncated. Keep the same source and range; continue with offset=${r.nextOffset}.` } : {})
        });
      }
      case 'extract_tables': {
        const doc = await readDocument(args, ctx, d);
        const { tables, omitted } = tablesOf(doc, args.range, clampInt(args.max_rows, 60, 1, 200), 9000, clampInt(args.row_offset, 0, 0, 1_000_000));
        if (!tables.length) return ok({ source: doc.name, kind: doc.kind, tables: [], note: 'No tables found in the selected range.' });
        return ok({ source: doc.name, kind: doc.kind, tables, ...(doc.warning ? { warning: doc.warning } : {}), ...(omitted ? { omitted_tables: omitted, note: 'More tables exist; narrow with range.' } : {}) });
      }
      case 'ocr_image': {
        const src = await resolveSource(args, ctx, d, 'image');
        const text = (src.ocrText || (await d.ocr(src.name, src.type, src.bytes))).trim();
        return text ? ok({ source: src.name, text: text.slice(0, 10000), truncated: text.length > 10000 }) : ok({ source: src.name, text: '', note: 'No text recognized in the image.' });
      }
      case 'describe_image': {
        if (!(await d.visionAvailable())) return fail('The current model cannot see images.', 'Switch to a vision-capable model, or use ocr_image to read text in the image.');
        const src = await resolveSource(args, ctx, d, 'image');
        const b64 = src.base64 ?? btoaBytes(src.bytes);
        return ok({ source: src.name, note: 'The image is attached to this tool result. Describe what you see.' }, { image: { data: b64, mimeType: src.type.startsWith('image/') ? src.type : mimeFor(src.name) } });
      }
      case 'transcribe_audio': {
        const src = await resolveSource(args, ctx, d, 'audio');
        const text = (src.docId && d.readIngested ? (await d.readIngested(ctx.chatId, src.docId)).text
          : src.ocrText || await d.transcribe(src.bytes, ingestionFileType(src.name, src.type).mime)).trim();
        if (!text) return fail('No speech recognized in this recording.');
        return ok({ source: src.name, text: text.slice(0, 10000), truncated: text.length > 10000 });
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  return undefined;
}

function btoaBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

