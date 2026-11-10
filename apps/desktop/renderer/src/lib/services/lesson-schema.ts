import { z } from 'zod';

/**
 * The wire format for `create_lesson`.
 *
 * Only structure lives here — the teaching rules are in `lesson-lint`, which
 * runs after this schema has normalised the arguments. Keeping refinements out
 * of the zod schema matters: the same object is converted to JSON Schema for
 * the tool definition, and a refinement would either be dropped silently or
 * break that conversion.
 */

const choiceSchema = z.object({
  text: z.string().min(1),
  correct: z.boolean().optional(),
  why: z.string().optional()
}).passthrough();

const variableSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.coerce.number(),
  min: z.coerce.number(),
  max: z.coerce.number(),
  step: z.coerce.number().positive().optional(),
  unit: z.string().optional()
}).passthrough();

const outputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  expression: z.string().min(1),
  unit: z.string().optional(),
  format: z.enum(['number', 'percent', 'currency', 'compact']).optional()
}).passthrough();

const modelSchema = z.object({
  variables: z.array(variableSchema).min(1).max(6),
  outputs: z.array(outputSchema).min(1).max(4),
  plot: z.object({
    expression: z.string().min(1),
    variable: z.string().min(1),
    label: z.string().optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    from: z.coerce.number().optional(),
    to: z.coerce.number().optional(),
    samples: z.coerce.number().int().positive().max(600).optional()
  }).passthrough().optional()
}).passthrough();

const chartFigureSchema = z.object({
  title: z.string().optional(),
  chartType: z.string().optional(),
  subtitle: z.string().optional(),
  labels: z.array(z.coerce.string()).min(1),
  datasets: z.array(z.object({
    label: z.coerce.string().optional(),
    data: z.array(z.coerce.number()).min(1)
  }).passthrough()).min(1)
}).passthrough();

const diagramFigureSchema = z.object({
  title: z.string().optional(),
  diagramType: z.string().optional(),
  source: z.string().min(1)
}).passthrough();

const infoCardFigureSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  rows: z.array(z.object({ label: z.string().min(1), value: z.string().min(1), hint: z.string().optional() }).passthrough()).min(1),
  footer: z.string().optional()
}).passthrough();

const blockSchema = z.object({
  type: z.enum(['pretest', 'explore', 'predict', 'choice', 'numeric', 'steps', 'reveal', 'figure', 'summary']),
  prompt: z.string().optional(),
  formula: z.string().optional(),
  choices: z.array(choiceSchema).optional(),
  numeric: z.object({
    answer: z.coerce.number(),
    tolerance: z.coerce.number().nonnegative().optional(),
    unit: z.string().optional()
  }).passthrough().optional(),
  answer: z.union([z.coerce.number(), z.string()]).optional(),
  why: z.string().optional(),
  hint: z.string().optional(),
  model: modelSchema.optional(),
  insight: z.string().optional(),
  expression: z.string().optional(),
  series: z.array(z.object({ x: z.coerce.number(), y: z.coerce.number() }).passthrough()).optional(),
  xRange: z.tuple([z.coerce.number(), z.coerce.number()]).optional(),
  yRange: z.tuple([z.coerce.number(), z.coerce.number()]).optional(),
  label: z.string().optional(),
  steps: z.array(z.object({ formula: z.string().optional(), note: z.string().min(1) }).passthrough()).optional(),
  body: z.string().optional(),
  tone: z.enum(['why', 'try', 'careful']).optional(),
  chart: chartFigureSchema.optional(),
  diagram: diagramFigureSchema.optional(),
  infoCard: infoCardFigureSchema.optional(),
  points: z.array(z.coerce.string()).optional(),
  next: z.array(z.coerce.string()).optional()
}).passthrough();

export const lessonArgsSchema = z.object({
  title: z.string().min(1).describe('The concept this lesson teaches, not a course title'),
  subtitle: z.string().optional(),
  subject: z.enum(['math', 'physics', 'chemistry', 'biology', 'cs', 'data', 'general']).optional(),
  mode: z.enum(['lesson', 'practice']).default('lesson').describe('lesson = explanation with interactions; practice = questions without hints or visuals'),
  blocks: z.array(blockSchema).min(3).max(14).describe('Ordered blocks; in lesson mode the first must be a question and the last is a summary'),
  path: z.string().min(1).optional().describe('Output file path')
}).passthrough();

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
}

function normalizeMode(value: unknown): 'lesson' | 'practice' {
  const text = String(value ?? '').trim().toLowerCase();
  return ['practice', 'practise', 'exercise', 'exercises', 'drill', 'quiz'].includes(text) ? 'practice' : 'lesson';
}

/** Accepts `choices: ["a", "b"]` + `correct: 1` / `*b` / `answer: "b"`. */
function repairChoices(block: AnyRecord): void {
  const raw = block.choices ?? block.options ?? block.answers;
  if (!Array.isArray(raw)) return;
  const correctIndex = Number.isFinite(block.correctIndex) ? Number(block.correctIndex)
    : Number.isFinite(block.correct) ? Number(block.correct)
      : Number.isFinite(block.answerIndex) ? Number(block.answerIndex)
        : null;
  const answerText = typeof block.answer === 'string' ? block.answer.trim().toLowerCase() : '';
  block.choices = raw.map((entry, index) => {
    if (typeof entry === 'string') {
      const starred = entry.trim().startsWith('*');
      const text = starred ? entry.trim().slice(1).trim() : entry.trim();
      const correct = starred
        || correctIndex === index
        || (!!answerText && answerText === text.toLowerCase());
      return { text, ...(correct ? { correct: true } : {}) };
    }
    const record = asRecord(entry);
    if (!record) return { text: String(entry ?? '') };
    return {
      ...record,
      text: String(record.text ?? record.label ?? record.value ?? '').trim(),
      ...(typeof record.correct === 'boolean' ? { correct: record.correct } : {}),
      ...(record.why === undefined && typeof record.reason === 'string' ? { why: record.reason } : {})
    };
  });
}

/**
 * Flattens the shapes models actually emit. Everything here is lossless: it
 * moves a value to where the schema expects it, never invents content.
 */
export function repairLessonArgs(args: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...args };
  out.mode = normalizeMode(args.mode);

  if (!Array.isArray(out.blocks) && Array.isArray(args.steps)) {
    // "steps" used as the whole lesson body.
    out.blocks = [{ type: 'pretest', prompt: String(args.title || 'What do you already know?'), choices: undefined, numeric: { answer: 0 } },
      { type: 'steps', prompt: String(args.title || 'Worked steps'), steps: args.steps.map((step) => (typeof step === 'string' ? { note: step } : step)) },
      { type: 'summary', points: [String(args.title || 'Summary')] }];
  }

  if (Array.isArray(out.blocks)) {
    out.blocks = out.blocks.map((entry) => {
      const block = asRecord(entry);
      if (!block) return entry;
      const next: AnyRecord = { ...block };
      next.type = String(block.type ?? '').trim().toLowerCase();
      if (next.type === 'question') next.type = 'choice';
      if (next.type === 'explain' || next.type === 'explanation') next.type = 'reveal';
      if (next.type === 'slider' || next.type === 'simulation') next.type = 'explore';
      if (next.type === 'draw' || next.type === 'guess') next.type = 'predict';
      if (next.type === 'worked' || next.type === 'derivation') next.type = 'steps';
      if (next.type === 'recap' || next.type === 'keyPoints') next.type = 'summary';
      if (next.type === 'text' || next.type === 'prose') next.type = 'reveal';
      if (next.type === 'chart' || next.type === 'diagram' || next.type === 'info_card') {
        const key = next.type === 'chart' ? 'chart' : next.type === 'diagram' ? 'diagram' : 'infoCard';
        next.type = 'figure';
        next[key] = block[key] ?? block.payload ?? entry;
      }

      if (typeof next.prompt !== 'string' && typeof block.question === 'string') next.prompt = block.question;
      if (typeof next.body !== 'string' && typeof block.content === 'string') next.body = block.content;

      repairChoices(next);

      if (!Array.isArray(next.steps) && Array.isArray(block.lines)) {
        next.steps = block.lines.map((line) => (typeof line === 'string' ? { note: line } : line));
      }
      if (Array.isArray(next.steps)) {
        next.steps = next.steps.map((line) => (typeof line === 'string' ? { note: line } : line));
      }

      // A multiple-choice pretest that shipped a bare numeric answer.
      if (next.type === 'pretest' && next.numeric === undefined && !Array.isArray(next.choices)) {
        const value = typeof block.answer === 'number' ? block.answer : Number(block.answer);
        if (Number.isFinite(value)) next.numeric = { answer: value, ...(block.tolerance !== undefined ? { tolerance: Number(block.tolerance) } : {}) };
      }

      if (next.type === 'diagram' || asRecord(next.diagram)) {
        const diagram = asRecord(next.diagram);
        if (diagram && typeof diagram.source !== 'string') {
          next.diagram = { ...diagram, source: String(diagram.mermaid_source ?? diagram.code ?? diagram.mermaid ?? '') };
        }
      }

      // Practice sets carry no scaffolding.
      if (out.mode === 'practice') delete next.hint;

      if (typeof next.points === 'string') next.points = String(next.points).split(/\n+/).map((line) => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
      return next;
    });
  }

  return out;
}
