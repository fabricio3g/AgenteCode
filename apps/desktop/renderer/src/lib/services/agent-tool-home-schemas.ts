import type { ToolDefinition } from '$lib/services/chat/types';

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } }
} as ToolDefinition);

const SOURCE = 'Attachment file name (or id), or a workspace file path. Omit when exactly one matching file is attached.';

/** Documents, productivity and media tools (grouped in agent-tool-registry.ts). */
export const HOME_EXTRA_TOOL_DEFS: ToolDefinition[] = [
  fn(
    'read_document',
    'Read an attached or workspace document, including indexed OCR scans, recording transcripts, PDF, DOCX, XLSX/CSV, PPTX, HTML, RTF, OpenDocument and EPUB. Select pages, sheets or slides with range; long output is truncated with a pointer to continue. Read all relevant ranges before producing a deliverable. To create a report or spreadsheet, use the create_* artifact tools.',
    {
      source: { type: 'string', description: SOURCE },
      range: { type: 'string', description: 'Pages/slides/sheets: "3", "2-5", "1,4-6" or a sheet name. Default: from the start.' },
      max_chars: { type: 'number', description: 'Output cap (default 8000, max 10000)' },
      offset: { type: 'number', description: 'Character offset within the selected range; continue using next_offset from a truncated result. Default 0.' }
    }
  ),
  fn(
    'extract_tables',
    'Extract tables as rows from an attached or workspace document. XLSX/CSV sheets are returned whole, DOCX/PPTX return their real tables, PDF tables are detected from text layout (best effort).',
    {
      source: { type: 'string', description: SOURCE },
      range: { type: 'string', description: 'Pages/slides/sheets to search (same syntax as read_document)' },
      max_rows: { type: 'number', description: 'Rows per table (default 60, max 200)' },
      row_offset: { type: 'number', description: 'Rows to skip per table; continue using nextRowOffset from a truncated table. Default 0.' }
    }
  ),
  fn(
    'notes',
    'Persistent notes shared across all chats on this device. Use to save things the user wants remembered and to recall them later.',
    {
      action: { type: 'string', enum: ['create', 'list', 'read', 'update', 'delete'] },
      id: { type: 'string', description: 'Note id (read/update/delete)' },
      title: { type: 'string' },
      body: { type: 'string', description: 'Full note text (create, or replace on update)' },
      append: { type: 'string', description: 'Text appended to the existing body (update)' },
      tags: { type: 'array', items: { type: 'string' } },
      query: { type: 'string', description: 'Filter by text (list)' },
      tag: { type: 'string', description: 'Filter by tag (list)' }
    },
    ['action']
  ),
  fn(
    'todos',
    "The user's persistent to-do list, shared across chats.",
    {
      action: { type: 'string', enum: ['add', 'list', 'complete', 'reopen', 'remove'] },
      id: { type: 'string', description: 'Item id (complete/reopen/remove)' },
      text: { type: 'string', description: 'Item text (add)' },
      due: { type: 'string', description: 'Optional due date, YYYY-MM-DD (add)' },
      status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Filter for list (default open)' }
    },
    ['action']
  ),
  fn(
    'reminders',
    'Reminders and timers. When one is due the app shows a notification (while it is running); pending ones survive a restart. Give in_minutes for a duration/timer, or at as an ISO 8601 time with an offset (use convert_time to get the right offset).',
    {
      action: { type: 'string', enum: ['set', 'list', 'cancel'] },
      text: { type: 'string', description: 'What to remind about (set)' },
      in_minutes: { type: 'number', description: 'Fire after this many minutes (set)' },
      at: { type: 'string', description: 'Absolute time, e.g. 2026-03-01T14:30:00-05:00 (set)' },
      id: { type: 'string', description: 'Reminder id (cancel)' }
    },
    ['action']
  ),
  fn(
    'convert_units',
    'Exact unit conversion: length, mass, volume, speed, data size and temperature (e.g. km to mi, lb to kg, c to f, GiB to MB).',
    {
      value: { type: 'number' },
      from: { type: 'string', description: 'Source unit, e.g. "km", "lb", "c", "gib"' },
      to: { type: 'string', description: 'Target unit' }
    },
    ['value', 'from', 'to']
  ),
  fn(
    'convert_time',
    'Convert a date/time between IANA time zones, or do date math (difference between two dates, or add days/months/hours). Omit datetime for "now". Use it instead of computing offsets yourself.',
    {
      datetime: { type: 'string', description: 'YYYY-MM-DD HH:mm (wall clock in from_zone) or ISO 8601 with offset; default now' },
      from_zone: { type: 'string', description: 'IANA zone of datetime (default: the device zone)' },
      to_zones: { type: 'array', items: { type: 'string' }, description: 'IANA zones to show the time in' },
      end: { type: 'string', description: 'Second date: returns the difference datetime → end' },
      add: { type: 'object', description: 'Shift datetime by {years, months, weeks, days, hours, minutes}' }
    }
  ),
  fn(
    'ocr_image',
    'Read the text in an attached image or screenshot (OCR, runs locally). Use for scans, receipts, screenshots of text.',
    { source: { type: 'string', description: SOURCE } }
  ),
  fn(
    'describe_image',
    'Look at an attached image with the current model and describe it. Works only when the current model supports vision; otherwise it says so (use ocr_image for text).',
    { source: { type: 'string', description: SOURCE } }
  ),
  fn(
    'transcribe_audio',
    'Transcribe an attached or workspace audio file to text with the local speech-to-text engine (whisper).',
    { source: { type: 'string', description: SOURCE } }
  )
];
