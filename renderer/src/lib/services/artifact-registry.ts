import { z } from 'zod';
import type { ToolDefinition } from '$lib/services/chat-api';
import type { ArtifactKind, ArtifactPresentation } from '$lib/types/chat';

export const ARTIFACT_ICON_NAMES = [
  'file-text',
  'briefcase',
  'table',
  'presentation',
  'file',
  'bar-chart',
  'workflow',
  'map',
  'layout-dashboard',
  'layout-list',
  'code',
  'library'
] as const;

export type ArtifactIconName = typeof ARTIFACT_ICON_NAMES[number];
export type ArtifactCategory = 'documents' | 'visuals' | 'cards' | 'research';

type ArtifactArgsSchema = z.ZodType<Record<string, unknown>>;

export interface ArtifactTypeEntry {
  id: Exclude<ArtifactKind, 'web' | 'files'>;
  name: string;
  description: string;
  icon: ArtifactIconName;
  category: ArtifactCategory;
  presentation: ArtifactPresentation;
  defaultEnabled: boolean;
  toolName: string;
  toolDescription: string;
  argsSchema: ArtifactArgsSchema;
  repairArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  toolDefinition: ToolDefinition;
}

type ArtifactDefinitionInput = Omit<ArtifactTypeEntry, 'toolDefinition'>;

function toToolParameters(schema: ArtifactArgsSchema): ToolDefinition['function']['parameters'] {
  const json = z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>;
  delete json.$schema;
  return json as ToolDefinition['function']['parameters'];
}

function defineArtifact<const T extends ArtifactDefinitionInput>(input: T): T & Pick<ArtifactTypeEntry, 'toolDefinition'> {
  return {
    ...input,
    toolDefinition: {
      type: 'function',
      function: {
        name: input.toolName,
        description: input.toolDescription,
        parameters: toToolParameters(input.argsSchema)
      }
    }
  } as T & Pick<ArtifactTypeEntry, 'toolDefinition'>;
}

const pathSchema = z.string().min(1).optional().describe('Output file path');
const sectionSchema = z.object({
  title: z.string().optional(),
  heading: z.string().optional(),
  content: z.string().optional(),
  bullets: z.array(z.string()).optional(),
  citations: z.array(z.string()).optional()
}).passthrough();

function repairInfoCardArgs(args: Record<string, unknown>): Record<string, unknown> {
  const rowInput = args.rows ?? args.items ?? args.facts ?? args.data ?? args.fields ?? args.details;
  const rawRows = Array.isArray(rowInput)
    ? rowInput
    : rowInput && typeof rowInput === 'object'
      ? Object.entries(rowInput as Record<string, unknown>).map(([label, value]) => ({ label, value }))
      : [];
  const rows = rawRows.map((row) => {
    if (Array.isArray(row)) return { label: String(row[0] ?? 'Detail'), value: String(row[1] ?? '—'), ...(row[2] ? { hint: String(row[2]) } : {}) };
    if (row && typeof row === 'object') {
      const value = row as Record<string, unknown>;
      return {
        label: String(value.label ?? value.name ?? value.key ?? value.title ?? 'Detail'),
        value: String(value.value ?? value.content ?? value.text ?? value.description ?? '—'),
        ...(value.hint ?? value.note ? { hint: String(value.hint ?? value.note) } : {})
      };
    }
    return { label: 'Detail', value: String(row ?? '') };
  }).filter((row) => row.value.trim());
  /*
   * Only emit `title` when there is one. This used to always emit
   * `String(args.title || '').trim()`, so a model that omitted the title got
   * `title: ''` — turning a clear "required" error into a baffling "Too small:
   * expected string to have >=1 characters" and making repair actively worse than
   * no repair. Common aliases are accepted before giving up.
   */
  const title = String(args.title ?? args.heading ?? args.name ?? args.label ?? '').trim();
  return {
    ...(title ? { title } : {}),
    ...(args.subtitle ? { subtitle: String(args.subtitle) } : {}),
    rows,
    ...(args.footer ? { footer: String(args.footer) } : {}),
    ...(args.accent ? { accent: String(args.accent) } : {}),
    ...(args.path ? { path: String(args.path) } : {})
  };
}

const builtinArtifacts = [
  defineArtifact({
    id: 'report', name: 'Reports', description: 'HTML or Markdown formatted report documents', icon: 'file-text', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_report', toolDescription: 'Create a formatted report document (HTML or Markdown) as an artifact.',
    argsSchema: z.object({
      title: z.string().min(1).describe('Report title'),
      sections: z.array(sectionSchema).min(1).describe('Report sections'),
      format: z.enum(['html', 'markdown']).optional().describe('Output format'),
      path: pathSchema,
      theme: z.enum(['light', 'dark']).optional().describe('Color theme for HTML reports')
    }).strict()
  }),
  defineArtifact({
    id: 'work_product', name: 'Work Products', description: 'Multi-format professional deliverables', icon: 'briefcase', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_work_product', toolDescription: 'Create a professional evidence-aware work product from one shared report schema.',
    argsSchema: z.object({
      title: z.string().min(1), subtitle: z.string().optional(), executiveSummary: z.string().optional(),
      sections: z.array(sectionSchema).min(1),
      tables: z.array(z.object({ name: z.string().optional(), columns: z.array(z.string()).optional(), rows: z.array(z.unknown()).optional() }).passthrough()).optional(),
      sources: z.array(z.object({ id: z.string().optional(), title: z.string().optional(), url: z.string().optional(), provider: z.string().optional(), snippet: z.string().optional() }).passthrough()).optional(),
      limitations: z.array(z.string()).optional(),
      formats: z.array(z.enum(['md', 'html', 'docx', 'xlsx', 'pptx', 'pdf'])).min(1),
      path: pathSchema
    }).strict()
  }),
  defineArtifact({
    id: 'document', name: 'Documents', description: 'DOCX documents with preview', icon: 'file-text', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_document', toolDescription: 'Create a real DOCX document with a built-in preview.',
    argsSchema: z.object({ title: z.string().min(1), sections: z.array(sectionSchema).optional(), content: z.string().optional(), path: pathSchema }).strict()
  }),
  defineArtifact({
    id: 'spreadsheet', name: 'Spreadsheets', description: 'XLSX workbooks with table viewer', icon: 'table', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_spreadsheet', toolDescription: 'Create a real XLSX workbook with a built-in table viewer.',
    argsSchema: z.object({
      title: z.string().min(1),
      sheets: z.array(z.object({ name: z.string().optional(), columns: z.array(z.string()).optional(), rows: z.array(z.unknown()).optional() }).passthrough()).optional(),
      columns: z.array(z.string()).optional(), rows: z.array(z.unknown()).optional(), path: pathSchema
    }).strict()
  }),
  defineArtifact({
    id: 'presentation', name: 'Presentations', description: 'PPTX slide decks with slide viewer', icon: 'presentation', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_presentation', toolDescription: 'Create a real PPTX slide deck with a built-in slide viewer.',
    argsSchema: z.object({ title: z.string().min(1), slides: z.array(z.object({ title: z.string().optional(), content: z.string().optional(), bullets: z.array(z.string()).optional(), notes: z.string().optional() }).passthrough()).min(1), path: pathSchema }).strict()
  }),
  defineArtifact({
    id: 'pdf', name: 'PDF Files', description: 'PDF documents with built-in viewer', icon: 'file', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_pdf', toolDescription: 'Create a PDF document with a built-in PDF viewer.',
    argsSchema: z.object({ title: z.string().min(1), sections: z.array(sectionSchema).optional(), content: z.string().optional(), path: pathSchema }).strict()
  }),
  defineArtifact({
    id: 'chart', name: 'Charts', description: 'Native inline bar, line, pie, and donut charts', icon: 'bar-chart', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_chart', toolDescription: 'Create a deterministic inline chart artifact rendered locally.',
    argsSchema: z.object({
      title: z.string().min(1), chart_type: z.enum(['bar', 'line', 'pie', 'donut']).default('bar'), labels: z.array(z.coerce.string()).min(1),
      datasets: z.array(z.object({ label: z.coerce.string().optional(), data: z.array(z.coerce.number()) }).strict()).min(1), path: pathSchema
    }).strict()
  }),
  defineArtifact({
    id: 'diagram', name: 'Diagrams', description: 'Native inline Mermaid diagrams', icon: 'workflow', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_diagram', toolDescription: 'Create a deterministic inline diagram artifact using Mermaid syntax.',
    argsSchema: z.object({ title: z.string().min(1), diagram_type: z.string().optional(), mermaid_source: z.string().min(1), path: pathSchema }).strict()
  }),
  defineArtifact({
    id: 'map', name: 'Maps', description: 'Inline coordinate maps with markers and polylines', icon: 'map', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_map',
    toolDescription: 'Create an inline map rendered locally from bundled world geometry. Supply `place` (a city or region name) and the coordinates are resolved for you, or give latitude/longitude directly.',
    argsSchema: z.object({
      /*
       * Either `place` or latitude/longitude. Supplying a name is strongly preferred:
       * a model that only had the coordinate fields would run a web search purely to
       * find a latitude before it could draw anything.
       */
      place: z.string().min(1).optional(),
      /*
       * Optional. It was `z.string().min(1)` under a `.strict()` schema, so a model
       * that sent only coordinates — the one thing a map actually needs — was
       * rejected outright and retried the identical call until it gave up. Nothing
       * downstream required it: `handleCreateMap` already falls back to 'Map', and
       * ArtifactMap renders the heading behind `{#if payload.title}`.
       */
      title: z.string().min(1).optional(), latitude: z.coerce.number().optional(), longitude: z.coerce.number().optional(), zoom: z.coerce.number().optional(),
      markers: z.array(z.object({ lat: z.coerce.number(), lng: z.coerce.number(), label: z.string().optional(), popup: z.string().optional() }).passthrough()).optional(),
      polylines: z.array(z.unknown()).optional(), path: pathSchema
    }).strict()
  }),
  defineArtifact({
    id: 'dashboard', name: 'Dashboards', description: 'Metric cards, KPIs, and summary panels', icon: 'layout-dashboard', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_dashboard', toolDescription: 'Create a deterministic inline dashboard artifact.',
    argsSchema: z.object({
      title: z.string().min(1), subtitle: z.string().optional(),
      metrics: z.array(z.object({ label: z.coerce.string(), value: z.union([z.string(), z.number()]), trend: z.string().optional(), unit: z.string().optional(), color: z.string().optional() }).passthrough()).min(1),
      sections: z.array(z.object({ heading: z.string().optional(), content: z.string().optional() }).passthrough()).optional(), path: pathSchema
    }).strict()
  }),
  defineArtifact({
    id: 'info_card', name: 'Info cards', description: 'Fact cards for live data and short structured summaries', icon: 'layout-list', category: 'cards', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_info_card', toolDescription: 'Create an optional evidence-backed inline info card. Never send empty rows or invent facts.',
    repairArgs: repairInfoCardArgs,
    argsSchema: z.object({
      title: z.string().min(1), subtitle: z.string().optional(),
      rows: z.array(z.object({ label: z.string().min(1), value: z.string().min(1), hint: z.string().optional() }).strict()).min(1),
      footer: z.string().optional(), accent: z.enum(['sky', 'green', 'amber', 'red', 'violet']).optional(), path: pathSchema
    }).strict()
  }),
  defineArtifact({
    id: 'html_card', name: 'HTML cards', description: 'Small self-contained HTML snippets', icon: 'code', category: 'cards', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_html_card', toolDescription: 'Create a small self-contained HTML card with no remote dependencies.',
    argsSchema: z.object({ title: z.string().min(1), html: z.string().min(1), path: pathSchema }).strict()
  }),
  defineArtifact({
    id: 'research_package', name: 'Research exports', description: 'Citations, evidence matrices, and bibliography files', icon: 'library', category: 'research', presentation: 'document', defaultEnabled: true,
    toolName: 'export_research_package', toolDescription: 'Export evidence-backed research deliverables from gathered sources.',
    argsSchema: z.object({ kinds: z.array(z.enum(['citations', 'matrix', 'shortlist', 'bibliography', 'protocol'])).min(1), title: z.string().optional(), query: z.string().optional() }).strict()
  })
] as const satisfies readonly ArtifactTypeEntry[];

export type ArtifactToolName = typeof builtinArtifacts[number]['toolName'];

const byToolName = new Map<string, ArtifactTypeEntry>(builtinArtifacts.map((artifact) => [artifact.toolName, artifact]));

export function getAllArtifacts(): readonly ArtifactTypeEntry[] {
  return builtinArtifacts;
}

export function getArtifactDefinitionByToolName(toolName: string): ArtifactTypeEntry | undefined {
  return byToolName.get(toolName);
}

export function parseArtifactToolArgs(toolName: string, rawArgs: Record<string, unknown>): { success: true; data: Record<string, unknown>; repaired: boolean } | { success: false; error: string } {
  const definition = getArtifactDefinitionByToolName(toolName);
  if (!definition) return { success: false, error: `Unknown artifact tool: ${toolName}` };
  const repaired = definition.repairArgs ? definition.repairArgs(rawArgs) : rawArgs;
  const parsed = definition.argsSchema.safeParse(repaired);
  if (parsed.success) return { success: true, data: parsed.data, repaired: !!definition.repairArgs && JSON.stringify(parsed.data) !== JSON.stringify(rawArgs) };
  const detail = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
  const required = definition.toolDefinition.function.parameters?.required;
  const hint = Array.isArray(required) && required.length
    ? ` Required: ${required.join(', ')}.`
    : '';
  return { success: false, error: `Invalid ${toolName} arguments: ${detail}.${hint}` };
}

export function getEnabledArtifactIds(toggles: Record<string, boolean> = {}): Set<string> {
  const enabled = new Set<string>();
  for (const artifact of builtinArtifacts) {
    const toggle = toggles[artifact.id];
    if (toggle === undefined ? artifact.defaultEnabled : toggle) enabled.add(artifact.id);
  }
  return enabled;
}

export function getArtifactIdByToolName(toolName: string): string | undefined {
  return getArtifactDefinitionByToolName(toolName)?.id;
}

export function isArtifactToolEnabled(toolName: string, toggles: Record<string, boolean>): boolean {
  const artifact = getArtifactDefinitionByToolName(toolName);
  return artifact ? (toggles[artifact.id] ?? artifact.defaultEnabled) : true;
}
