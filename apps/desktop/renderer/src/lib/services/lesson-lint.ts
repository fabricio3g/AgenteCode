/**
 * The teaching rules a lesson has to satisfy before it can be shown.
 *
 * These are mechanics, never content: a question before the explanation, a
 * reason attached to every wrong option, no scaffolding inside a practice set,
 * a summary to close on. Lint runs after the zod schema has normalised the
 * arguments (so it may assume arrays exist) and before anything is written, so
 * a broken lesson fails the tool call with a message the model can act on
 * instead of shipping a document with buttons on it.
 */

export interface LessonLintIssue {
  /** Dotted path inside the arguments, e.g. `blocks.2.choices.1.why`. */
  path: string;
  message: string;
}

export interface LessonLintResult {
  errors: LessonLintIssue[];
  warnings: LessonLintIssue[];
}

const QUESTION_TYPES = new Set(['pretest', 'choice', 'visual_choice', 'graph_challenge', 'numeric', 'predict']);
/** Blocks that are explanation rather than interaction, for the wall-of-text rule. */
const READING_TYPES = new Set(['steps', 'reveal', 'figure']);
const PRACTICE_TYPES = new Set(['choice', 'visual_choice', 'graph_challenge', 'numeric', 'summary']);

const PROMPT_WORD_LIMIT = 60;
const BODY_WORD_LIMIT = 220;
const MIN_BLOCKS = 3;
const MAX_BLOCKS = 14;
const MAX_READING_RUN = 2;
const MAX_CHOICES = 5;

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
}

function words(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.split(/\s+/).length : 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Shared by `choice` and a multiple-choice `pretest`. */
function checkChoices(choices: unknown[], path: string, errors: LessonLintIssue[]): void {
  if (choices.length < 2) {
    errors.push({ path, message: 'A question needs at least two answer options.' });
    return;
  }
  if (choices.length > MAX_CHOICES) {
    errors.push({ path, message: `Use ${MAX_CHOICES} options at most; fewer reads better.` });
  }
  const records = choices.map((choice) => asRecord(choice)).filter(Boolean) as AnyRecord[];
  const correct = records.filter((choice) => choice.correct === true);
  if (correct.length !== 1) {
    errors.push({
      path,
      message: correct.length === 0
        ? 'Exactly one option must be marked correct: true.'
        : 'Exactly one option may be marked correct; this has more than one.'
    });
  }
  records.forEach((choice, index) => {
    const why = typeof choice.why === 'string' ? choice.why.trim() : '';
    const text = typeof choice.text === 'string' ? choice.text.trim() : '';
    if (!text) errors.push({ path: `${path}.${index}.text`, message: 'Every option needs its own text.' });
    // The reason is what makes feedback feel like a tutor rather than a key.
    if (choice.correct !== true && !why) {
      errors.push({
        path: `${path}.${index}.why`,
        message: 'A wrong option needs a "why" saying what the reader may have assumed.'
      });
    }
  });
}

function checkNumericAnswer(block: AnyRecord, path: string, errors: LessonLintIssue[]): void {
  const numeric = asRecord(block.numeric) ?? block;
  const answer = numeric.answer;
  if (!finite(answer)) {
    errors.push({ path: `${path}.answer`, message: 'A numeric question needs a finite answer.' });
    return;
  }
  const tolerance = numeric.tolerance;
  if (!Number.isInteger(answer) && !finite(tolerance)) {
    errors.push({
      path: `${path}.tolerance`,
      message: 'A fractional answer needs a tolerance (for example 0.01) so a rounded answer can be accepted.'
    });
  }
}

function checkExplore(block: AnyRecord, path: string, errors: LessonLintIssue[]): void {
  const model = asRecord(block.model);
  if (!model) {
    errors.push({ path: `${path}.model`, message: 'An explore block needs a model with variables and outputs.' });
    return;
  }
  const variables = Array.isArray(model.variables) ? model.variables : [];
  const outputs = Array.isArray(model.outputs) ? model.outputs : [];
  if (variables.length < 1) {
    errors.push({ path: `${path}.model.variables`, message: 'An explore block needs at least one variable to move.' });
  }
  if (variables.length > 6) {
    errors.push({ path: `${path}.model.variables`, message: 'Use 6 variables at most — more than that is a control panel, not an explanation.' });
  }
  if (outputs.length < 1) {
    errors.push({ path: `${path}.model.outputs`, message: 'An explore block needs at least one output to watch.' });
  }
}

function lessonMode(args: AnyRecord): 'lesson' | 'practice' {
  return String(args.mode || '').trim().toLowerCase() === 'practice' ? 'practice' : 'lesson';
}

export function lintLesson(args: AnyRecord): LessonLintResult {
  const errors: LessonLintIssue[] = [];
  const warnings: LessonLintIssue[] = [];
  const mode = lessonMode(args);
  const blocks = Array.isArray(args.blocks) ? args.blocks.map((block) => asRecord(block)) : [];

  if (!blocks.length) {
    errors.push({ path: 'blocks', message: 'A lesson needs blocks: a question first, a summary last.' });
    return { errors, warnings };
  }
  if (blocks.length < MIN_BLOCKS) {
    errors.push({ path: 'blocks', message: `A ${mode} needs at least ${MIN_BLOCKS} blocks.` });
  }
  if (blocks.length > MAX_BLOCKS) {
    errors.push({ path: 'blocks', message: `Keep it to ${MAX_BLOCKS} blocks at most; one concept per lesson.` });
  }

  let readingRun = 0;
  blocks.forEach((block, index) => {
    const path = `blocks.${index}`;
    if (!block) {
      errors.push({ path, message: 'Every block must be an object with a type.' });
      return;
    }
    const type = String(block.type || '').trim();

    if (mode === 'practice') {
      if (!PRACTICE_TYPES.has(type)) {
        errors.push({
          path: `${path}.type`,
          message: `Practice sets hold only choice, numeric and summary blocks. "${type || 'unknown'}" is scaffolding — use mode "lesson" for that.`
        });
      }
      if (typeof block.hint === 'string' && block.hint.trim()) {
        errors.push({ path: `${path}.hint`, message: 'Practice sets have no hints: the reader answers unaided.' });
      }
    }

    if (index === 0 && mode === 'lesson' && !QUESTION_TYPES.has(type)) {
      errors.push({
        path: `${path}.type`,
        message: 'A lesson opens with a question (pretest, choice, numeric or predict) before it explains anything.'
      });
    }
    if (READING_TYPES.has(type)) {
      readingRun += 1;
      if (readingRun > MAX_READING_RUN) {
        errors.push({
          path: `${path}.type`,
          message: 'At most two explanation blocks in a row — put a question between them.'
        });
      }
    } else if (type !== 'summary') {
      readingRun = 0;
    }

    if (PROMPT_WORD_LIMIT && words(block.prompt) > PROMPT_WORD_LIMIT) {
      warnings.push({ path: `${path}.prompt`, message: `The prompt is long (${words(block.prompt)} words); ${PROMPT_WORD_LIMIT} or fewer reads better.` });
    }

    switch (type) {
      case 'pretest': {
        const choices = Array.isArray(block.choices) ? block.choices : [];
        if (choices.length) checkChoices(choices, `${path}.choices`, errors);
        else checkNumericAnswer(block, path, errors);
        break;
      }
      case 'choice':
      case 'visual_choice':
        checkChoices(Array.isArray(block.choices) ? block.choices : [], `${path}.choices`, errors);
        break;
      case 'graph_challenge': {
        if (!String(block.expression || '').trim()) {
          errors.push({ path: `${path}.expression`, message: 'graph_challenge needs a math expression in x.' });
        }
        if (!finite(block.target)) {
          errors.push({ path: `${path}.target`, message: 'graph_challenge needs a finite numeric target.' });
        }
        break;
      }
      case 'hotspot_diagram': {
        const pins = Array.isArray(block.pins) ? block.pins : [];
        if (pins.length < 2) errors.push({ path: `${path}.pins`, message: 'hotspot_diagram needs at least two labeled pins.' });
        break;
      }
      case 'timeline_story': {
        const eras = Array.isArray(block.eras) ? block.eras : [];
        if (eras.length < 2) errors.push({ path: `${path}.eras`, message: 'timeline_story needs at least two eras.' });
        break;
      }
      case 'algo_stepper': {
        const data = Array.isArray(block.data) ? block.data : [];
        const steps = Array.isArray(block.steps) ? block.steps : [];
        if (!data.length || !steps.length) errors.push({ path, message: 'algo_stepper needs data items and at least one step.' });
        break;
      }
      case 'numeric':
        checkNumericAnswer(block, path, errors);
        break;
      case 'explore':
        checkExplore(block, path, errors);
        break;
      case 'predict': {
        const range = block.xRange;
        if (!Array.isArray(range) || range.length !== 2 || !finite(range[0]) || !finite(range[1]) || range[0] >= range[1]) {
          errors.push({ path: `${path}.xRange`, message: 'predict needs xRange: [from, to] with from < to.' });
        }
        if (!String(block.expression || '').trim() && !Array.isArray(block.series)) {
          errors.push({ path: `${path}.expression`, message: 'predict needs an expression (or explicit series) to show once the reader has drawn their guess.' });
        }
        break;
      }
      case 'steps': {
        const steps = Array.isArray(block.steps) ? block.steps : [];
        if (!steps.length) errors.push({ path: `${path}.steps`, message: 'steps needs at least one { formula, note } line.' });
        break;
      }
      case 'reveal':
        if (!String(block.body || '').trim()) errors.push({ path: `${path}.body`, message: 'A reveal block needs a body.' });
        if (words(block.body) > BODY_WORD_LIMIT) {
          warnings.push({ path: `${path}.body`, message: `The explanation is long (${words(block.body)} words).` });
        }
        break;
      case 'figure': {
        const kinds = ['chart', 'diagram', 'infoCard'].filter((key) => asRecord(block[key]));
        if (kinds.length !== 1) {
          errors.push({ path, message: 'A figure block carries exactly one of chart, diagram or infoCard.' });
        }
        break;
      }
      case 'summary': {
        const points = Array.isArray(block.points) ? block.points : [];
        if (!points.length) errors.push({ path: `${path}.points`, message: 'A summary needs at least one point.' });
        if (points.length > 6) warnings.push({ path: `${path}.points`, message: 'Keep a summary to six points at most.' });
        break;
      }
      default:
        if (!['pretest', 'explore', 'predict', 'choice', 'numeric', 'steps', 'reveal', 'figure', 'summary'].includes(type)) {
          errors.push({
            path: `${path}.type`,
            message: `Unknown block type "${type}". Use pretest, explore, predict, choice, numeric, steps, reveal, figure or summary.`
          });
        }
    }
  });

  const last = blocks[blocks.length - 1];
  if (last && String(last.type || '') !== 'summary') {
    errors.push({ path: `blocks.${blocks.length - 1}.type`, message: 'A lesson ends with a summary block.' });
  }

  if (mode === 'practice' && !blocks.some((block) => block && ['choice', 'numeric'].includes(String(block.type || '')))) {
    errors.push({ path: 'blocks', message: 'A practice set needs at least one question.' });
  }

  return { errors, warnings };
}

/** The manifest-facing shape: only warnings become `artifact.pedagogy` issues. */
export function pedagogyIssues(warnings: LessonLintIssue[]): Array<{ code: string; severity: 'warning'; message: string; path?: string }> {
  return warnings.slice(0, 4).map((issue) => ({
    code: 'artifact.pedagogy',
    severity: 'warning' as const,
    message: issue.message,
    ...(issue.path ? { path: issue.path } : {})
  }));
}
