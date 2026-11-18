import { CHART_TYPES, resolveChartType } from '$lib/utils/chart-types';
import { z } from 'zod';
import type { ToolDefinition } from '$lib/services/chat/types';
import type { ArtifactKind, ArtifactPresentation } from '$lib/types/chat';
import { lessonArgsSchema, repairLessonArgs } from '$lib/services/lesson-schema';
import { lintLesson, pedagogyIssues, type LessonLintIssue } from '$lib/services/lesson-lint';

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
  'library',
  'sparkles',
  'graduation-cap'
] as const;

export type ArtifactIconName = typeof ARTIFACT_ICON_NAMES[number];
export type ArtifactCategory = 'documents' | 'visuals' | 'cards' | 'learning' | 'research';

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
  /**
   * Rules the schema cannot express (they are about pedagogy, not shape). Errors
   * fail the call with an actionable message; warnings ride on the manifest as
   * `artifact.pedagogy` issues. Runs after the schema has normalised the args.
   */
  lintArgs?: (args: Record<string, unknown>) => { errors: LessonLintIssue[]; warnings: LessonLintIssue[] };
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

const infoCardAccentSchema = z.enum(['sky', 'green', 'amber', 'red', 'violet']);
const pathSchema = z.string().min(1).optional().describe('Output file path');
const spreadsheetColumn = z.union([z.string(), z.object({
  header: z.string().optional(), key: z.string().optional(), width: z.number().positive().optional(),
  numFmt: z.string().optional().describe('Excel number format, for example $#,##0.00, 0.0%, or yyyy-mm-dd'),
})]);
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
  // Decoration must not reject usable facts; omit unknown colors for the viewer default.
  const accent = infoCardAccentSchema.safeParse(typeof args.accent === 'string' ? args.accent.trim().toLowerCase() : undefined);
  return {
    ...(title ? { title } : {}),
    ...(args.subtitle ? { subtitle: String(args.subtitle) } : {}),
    rows,
    ...(args.footer ? { footer: String(args.footer) } : {}),
    ...(accent.success ? { accent: accent.data } : {}),
    ...(args.path ? { path: String(args.path) } : {})
  };
}

const chartArgsSchema = z.object({
      title: z.string().min(1),
      // Models reach for the chart vocabulary they know; map the common names.
      chart_type: z.preprocess(
        (value) => (resolveChartType(value) ?? value),
        z.enum(CHART_TYPES)
      ).default('bar'),
      labels: z.array(z.coerce.string()).min(1),
      datasets: z.array(z.object({ label: z.coerce.string().optional(), data: z.array(z.coerce.number().finite()).min(1).max(1000), sizes: z.array(z.coerce.number().positive()).max(1000).optional() })).min(1).max(24),
      subtitle: z.string().optional(),
      valueFormat: z.enum(['number', 'percent', 'currency']).optional().describe('percent values are percentage points (18 = 18%)'),
      currency: z.string().optional().describe('ISO currency code, e.g. USD'),
      max: z.number().positive().optional().describe('Gauge upper bound'),
      annotations: z.array(z.object({ label: z.string(), index: z.number().int().nonnegative() })).optional().describe('Events marked at a zero-based label index'),
      path: pathSchema
    });

const builtinArtifacts = [
  defineArtifact({
    id: 'report', name: 'Reports', description: 'HTML or Markdown formatted report documents', icon: 'file-text', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_report', toolDescription: 'Create a formatted report document (HTML or Markdown) as an artifact.',
    argsSchema: z.object({
      title: z.string().min(1).describe('Report title'),
      // Optional: a model that supplies prose in `content` should not be
      // rejected for omitting a section array it never needed.
      sections: z.array(sectionSchema).min(1).optional().describe('Report sections'),
      content: z.string().optional().describe('Report body when not split into sections'),
      format: z.enum(['html', 'markdown']).optional().describe('Output format'),
      path: pathSchema,
      subtitle: z.string().optional(),
      theme: z.enum(['light', 'dark']).optional().describe('Fixed palette for HTML reports. Omit for adaptive light and dark.'),
      accent: z.enum(['slate', 'blue', 'green', 'amber', 'rose', 'violet']).optional().describe('One muted accent color for HTML reports')
    })
  }),
  defineArtifact({
    id: 'work_product', name: 'Work Products', description: 'Multi-format professional deliverables', icon: 'briefcase', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_work_product', toolDescription: 'Create a professional evidence-aware work product from one shared report schema.',
    argsSchema: z.object({
      title: z.string().min(1), subtitle: z.string().optional(), executiveSummary: z.string().optional(),
      sections: z.array(sectionSchema).min(1).optional(),
      tables: z.array(z.object({ name: z.string().optional(), columns: z.array(spreadsheetColumn).optional(), rows: z.array(z.unknown()).optional() }).passthrough()).optional(),
      sources: z.array(z.object({ id: z.string().optional(), title: z.string().optional(), url: z.string().optional(), provider: z.string().optional(), snippet: z.string().optional() }).passthrough()).optional(),
      limitations: z.array(z.string()).optional(),
      // Defaulted: omitting it used to fail the call outright.
      formats: z.array(z.enum(['md', 'html', 'docx', 'xlsx', 'pptx', 'pdf'])).min(1).default(['md']),
      path: pathSchema
    })
  }),
  defineArtifact({
    id: 'document', name: 'Documents', description: 'DOCX documents with preview', icon: 'file-text', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_document', toolDescription: 'Create a real DOCX document with a built-in preview.',
    argsSchema: z.object({ title: z.string().min(1), sections: z.array(sectionSchema).optional(), content: z.string().optional(), path: pathSchema })
  }),
  defineArtifact({
    id: 'spreadsheet', name: 'Spreadsheets', description: 'XLSX workbooks with table viewer', icon: 'table', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_spreadsheet', toolDescription: 'Create a real XLSX workbook with a built-in table viewer.',
    argsSchema: z.object({
      title: z.string().min(1),
      sheets: z.array(z.object({ name: z.string().optional(), columns: z.array(spreadsheetColumn).optional(), rows: z.array(z.unknown()).optional() }).passthrough()).optional(),
      columns: z.array(spreadsheetColumn).optional(), rows: z.array(z.unknown()).optional(), path: pathSchema
    })
  }),
  defineArtifact({
    id: 'presentation', name: 'Presentations', description: 'PPTX slide decks with slide viewer', icon: 'presentation', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_presentation',
    toolDescription: 'Create a real PPTX slide deck in a clean, minimal design. Give each slide the layout that fits its content: title, section, bullets, two-column (left/right), quote, stats (2–4 big numbers), table, or chart (native PowerPoint chart). Keep bullets short; put detail in notes.',
    argsSchema: z.object({
      title: z.string().min(1),
      subtitle: z.string().optional(),
      theme: z.enum(['light', 'dark']).optional().describe('Slide background'),
      accent: z.enum(['slate', 'blue', 'green', 'amber', 'rose', 'violet']).optional().describe('One muted accent color'),
      slides: z.array(z.object({
        layout: z.enum(['title', 'section', 'bullets', 'two-column', 'quote', 'stats', 'table', 'chart']).optional(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        bullets: z.array(z.string()).optional(),
        content: z.string().optional(),
        left: z.object({ heading: z.string().optional(), bullets: z.array(z.string()) }).optional().describe('two-column: left column'),
        right: z.object({ heading: z.string().optional(), bullets: z.array(z.string()) }).optional().describe('two-column: right column'),
        quote: z.string().optional(),
        attribution: z.string().optional(),
        stats: z.array(z.object({ value: z.string(), label: z.string() })).max(4).optional().describe('stats: big numbers with labels'),
        table: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.coerce.string())) }).optional(),
        chart: z.object({
          type: z.enum(['column', 'bar', 'line', 'pie', 'doughnut']).optional(),
          labels: z.array(z.coerce.string()),
          series: z.array(z.object({ name: z.string(), values: z.array(z.coerce.number()) }))
        }).optional(),
        notes: z.string().optional().describe('Speaker notes')
      }).passthrough()).min(1),
      path: pathSchema
    })
  }),
  defineArtifact({
    id: 'pdf', name: 'PDF Files', description: 'PDF documents with built-in viewer', icon: 'file', category: 'documents', presentation: 'document', defaultEnabled: true,
    toolName: 'create_pdf', toolDescription: 'Create a PDF document with a built-in PDF viewer.',
    argsSchema: z.object({ title: z.string().min(1), sections: z.array(sectionSchema).optional(), content: z.string().optional(), path: pathSchema })
  }),
  defineArtifact({
    id: 'chart', name: 'Charts', description: '23 interactive chart types, from trends and distributions to heatmaps', icon: 'bar-chart', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_chart', toolDescription: 'Create an interactive chart rendered locally. Choose the chart that answers the question; use an insight as the title and a concise subtitle with units and timeframe. Types: grouped/horizontal/stacked/100% bars; line/step/area/stacked/100% area; pie/donut; scatter/bubble; heatmap; histogram; waterfall; radar; lollipop/dot; boxplot; funnel; treemap; gauge. Standard data: labels and equal-length datasets. Scatter/bubble labels are numeric x values; bubble sizes are optional positive values. Heatmap: labels are columns, datasets are rows. Histogram and boxplot: supply raw samples, not pre-binned counts. Waterfall: data are sequential changes. Pie/donut/funnel/treemap/histogram use the first dataset. Gauge uses the first value and max (default 100). Percent stacks and area stacks require non-negative values. Do not invent data.',
    argsSchema: chartArgsSchema
  }),
  defineArtifact({
    id: 'diagram', name: 'Diagrams', description: 'Native inline Mermaid diagrams', icon: 'workflow', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_diagram', toolDescription: 'Create a deterministic inline diagram artifact using Mermaid syntax.',
    argsSchema: z.object({ title: z.string().min(1), diagram_type: z.string().optional(), mermaid_source: z.string().min(1), path: pathSchema })
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
    })
  }),
  defineArtifact({
    id: 'dashboard', name: 'Dashboards', description: 'Metric cards, KPIs, and summary panels', icon: 'layout-dashboard', category: 'visuals', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_dashboard', toolDescription: 'Create an analytical dashboard with a compact metric strip and optional native charts. Write specific insight titles, a concise units/timeframe subtitle, and short interpretation sections. charts accept the same fields and 23 types as create_chart.',
    argsSchema: z.object({
      title: z.string().min(1), subtitle: z.string().optional(),
      metrics: z.array(z.object({ label: z.coerce.string(), value: z.union([z.string(), z.number()]), trend: z.string().optional(), unit: z.string().optional(), color: z.string().optional() }).passthrough()).min(1),
      sections: z.array(z.object({ heading: z.string().optional(), content: z.string().optional() }).passthrough()).optional(),
      charts: z.array(chartArgsSchema.omit({ path: true })).max(12).optional(), path: pathSchema
    })
  }),
  defineArtifact({
    id: 'info_card', name: 'Info cards', description: 'Fact cards for live data and short structured summaries', icon: 'layout-list', category: 'cards', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_info_card', toolDescription: 'Create an optional evidence-backed inline info card. Never send empty rows or invent facts.',
    repairArgs: repairInfoCardArgs,
    argsSchema: z.object({
      title: z.string().min(1), subtitle: z.string().optional(),
      rows: z.array(z.object({ label: z.string().min(1), value: z.string().min(1), hint: z.string().optional() })).min(1),
      footer: z.string().optional(), accent: infoCardAccentSchema.optional(), path: pathSchema
    })
  }),
  defineArtifact({
    id: 'html_card', name: 'HTML cards', description: 'Small self-contained HTML snippets', icon: 'code', category: 'cards', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_html_card', toolDescription: 'Create a small self-contained HTML card with no remote dependencies.',
    argsSchema: z.object({ title: z.string().min(1), html: z.string().min(1), path: pathSchema })
  }),
  defineArtifact({
    id: 'widget', name: 'Interactive widgets', description: 'Small interactive views: calculators, comparisons, quizzes, explainers', icon: 'sparkles', category: 'cards', presentation: 'inline', defaultEnabled: true,
    toolName: 'create_widget',
    toolDescription: [
      'Build a small interactive view inline in chat (dynamic view): a calculator with sliders, a comparison with toggles, a quiz or flashcards, a checklist, a timeline, a step-by-step explainer with tabs, a what-if simulation.',
      'html: the markup. script: plain JavaScript that makes it interactive (optional). Runs offline in a sealed frame: no network, no external libraries, no storage.',
      'Style with the built-in classes, not your own colors: fx-stack, fx-row, fx-between, fx-grid, fx-metrics (compact KPI strip), fx-card, fx-chart, fx-insight, fx-caption, fx-label, fx-value, fx-muted, fx-small, fx-btn (primary, ghost), fx-seg (buttons with class on), fx-tabs, fx-chip (good, bad, warn, info), fx-bar > span, fx-list, fx-timeline, fx-up, fx-down, fx-divider; plain table, details/summary, input[type=range] are styled too.',
      'Helpers in script: fx.$(sel), fx.$$(sel), fx.num(n), fx.money(n, "EUR"), fx.pct(0.12), fx.ask("follow-up question") to suggest a next question.',
      'Use real numbers from the conversation or tools. Keep it compact.'
    ].join(' '),
    argsSchema: z.object({ title: z.string().min(1), html: z.string().min(1), script: z.string().optional(), path: pathSchema })
  }),
  defineArtifact({
    id: 'lesson', name: 'Lessons', description: 'Interactive explanations and practice sets, built only when asked for', icon: 'graduation-cap', category: 'learning', presentation: 'inline', defaultEnabled: false,
    toolName: 'create_lesson',
    toolDescription: [
      'Build an interactive lesson in Home: a guided explanation (mode "lesson") or a scaffold-free practice set (mode "practice").',
      'Build one only when the user asked for it — said "teach me", "explain interactively", "quiz me", used /teach or /practice, or clicked an offer to turn an answer into a lesson. Never replace a direct answer with a lesson, and never create a second artifact for a follow-up question.',
      'mode "lesson": blocks in this order — pretest (a question BEFORE any explanation), explore (1–6 sliders, expression-based outputs, optional plot), predict (reader drags a guess, then the true curve appears), steps (worked lines with LaTeX), reveal, figure (one of chart / diagram / infoCard), summary. The first block must be a question, at most two explanation blocks in a row, the last block is summary.',
      'mode "practice": choice and numeric blocks only, no hints, no visuals, ends with summary. Use it for retrieval practice after a lesson.',
      'Rules that fail the call: prose before the first question, a wrong option without its own why, a hint or explore block in practice, a fractional answer without tolerance, a last block that is not summary.',
      'Expressions are evaluated safely (no scripts): + - * / ^, parentheses, sin cos tan sqrt abs exp ln log, pi e tau, variable keys. LaTeX goes in prompt/formula/note fields.',
      'Shape: { title, subtitle?, subject?: math|physics|chemistry|biology|cs|data|general, mode, blocks: [ { type: "choice", prompt, choices: [{ text, correct?, why }] }, { type: "explore", prompt, model: { variables: [{ key, label, value, min, max, step?, unit? }], outputs: [{ key, label, expression, unit?, format? }], plot?: { expression, variable } } }, { type: "summary", points: [] } ] }. Real numbers only: no invented data, no scores.'
    ].join(' '),
    repairArgs: repairLessonArgs,
    lintArgs: lintLesson,
    argsSchema: lessonArgsSchema
  })
  // Research exports (citations, evidence matrix, …) are not an artifact: the
  // research widget on Search / Deep / Max answers builds them on demand.
] as const satisfies readonly ArtifactTypeEntry[];

export type ArtifactToolName = typeof builtinArtifacts[number]['toolName'];

const byToolName = new Map<string, ArtifactTypeEntry>(builtinArtifacts.map((artifact) => [artifact.toolName, artifact]));

export function getAllArtifacts(): readonly ArtifactTypeEntry[] {
  return builtinArtifacts;
}

export function getArtifactDefinitionByToolName(toolName: string): ArtifactTypeEntry | undefined {
  return byToolName.get(toolName);
}

export function parseArtifactToolArgs(toolName: string, rawArgs: Record<string, unknown>): { success: true; data: Record<string, unknown>; repaired: boolean; warnings?: Array<{ code: string; severity: 'warning'; message: string; path?: string }> } | { success: false; error: string } {
  const definition = getArtifactDefinitionByToolName(toolName);
  if (!definition) return { success: false, error: `Unknown artifact tool: ${toolName}` };
  const repaired = definition.repairArgs ? definition.repairArgs(rawArgs) : rawArgs;
  const parsed = definition.argsSchema.safeParse(repaired);
  const required = definition.toolDefinition.function.parameters?.required;
  const hint = Array.isArray(required) && required.length
    ? ` Required: ${required.join(', ')}.`
    : '';
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
    return { success: false, error: `Invalid ${toolName} arguments: ${detail}.${hint}` };
  }

  // Pedagogy rules run on the normalised arguments: shape is the schema's job,
  // teaching order and feedback are the linter's.
  let warnings: Array<{ code: string; severity: 'warning'; message: string; path?: string }> | undefined;
  if (definition.lintArgs) {
    const lint = definition.lintArgs(parsed.data as Record<string, unknown>);
    if (lint.errors.length) {
      const detail = lint.errors.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join('; ');
      return { success: false, error: `Invalid ${toolName} lesson: ${detail}.${hint}` };
    }
    if (lint.warnings.length) warnings = pedagogyIssues(lint.warnings);
  }

  const data = parsed.data as Record<string, unknown>;
  const changed = !!definition.repairArgs && JSON.stringify(data) !== JSON.stringify(rawArgs);
  return { success: true, data, repaired: changed, ...(warnings ? { warnings } : {}) };
}

export function getEnabledArtifactIds(toggles: Record<string, boolean> = {}): Set<string> {
  const enabled = new Set<string>();
  for (const artifact of builtinArtifacts) {
    const toggle = toggles[artifact.id];
    if (toggle === undefined ? artifact.defaultEnabled : toggle) enabled.add(artifact.id);
  }
  return enabled;
}

export function isArtifactToolEnabled(toolName: string, toggles: Record<string, boolean>): boolean {
  const artifact = getArtifactDefinitionByToolName(toolName);
  return artifact ? (toggles[artifact.id] ?? artifact.defaultEnabled) : true;
}
