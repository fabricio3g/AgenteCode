// Names on the subagent model list. The agent picks a model by its name, so a
// saved name follows the runtime's rule (`config::SubagentSettings::validate`):
// lowercase letters, digits, `.`, `_` or `-`, unique, and never `main`, which
// means "the conversation's own model". The editor never refuses what is
// typed: it folds it into that shape as you type and settles it when you
// leave the field (Postel's law: be liberal in what you accept).

type Named = { name: string; model?: string };

/** What a keystroke leaves in the name field: lowercased, accents dropped, other characters as `-`. */
export function typedName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}

function slug(text: string): string {
  return typedName(text).replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

function free(base: string, rows: Named[], index: number): string {
  const taken = new Set(rows.filter((_, i) => i !== index).map((row) => row.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * A name for a newly chosen model: its last path segment, then `-2`, `-3`…
 * while taken — the rule the runtime uses when it migrates old pins.
 */
export function modelName(model: string, rows: Named[], index = -1): string {
  let base = slug(model.split('/').pop() ?? model);
  if (!base || base === 'main') base = 'model';
  return free(base, rows, index);
}

/**
 * The name `rows[index]` keeps once its field loses focus: tidied, named
 * after its model when emptied, never `main`, and unique.
 */
export function settledName(rows: Named[], index: number): string {
  const row = rows[index];
  if (!row) return '';
  const base = slug(row.name);
  if (!base) return row.model ? modelName(row.model, rows, index) : '';
  return free(base === 'main' ? 'main-model' : base, rows, index);
}
