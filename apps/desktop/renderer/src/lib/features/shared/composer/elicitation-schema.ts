export interface ElicitationOption {
  value: string;
  label: string;
  description?: string;
}

export type ElicitationField =
  | {
      kind: 'single_select';
      key: string;
      title: string;
      description?: string;
      required: boolean;
      options: ElicitationOption[];
      defaultValue?: string;
      customKey?: string;
      customLabel?: string;
      customPlaceholder?: string;
    }
  | {
      kind: 'multi_select';
      key: string;
      title: string;
      description?: string;
      required: boolean;
      options: ElicitationOption[];
      defaultValue?: string[];
      customKey?: string;
      customLabel?: string;
      customPlaceholder?: string;
    }
  | {
      kind: 'boolean';
      key: string;
      title: string;
      description?: string;
      required: boolean;
      defaultValue?: boolean;
    }
  | {
      kind: 'number';
      key: string;
      title: string;
      description?: string;
      required: boolean;
      isInteger: boolean;
      defaultValue?: number;
    }
  | {
      kind: 'text';
      key: string;
      title: string;
      description?: string;
      required: boolean;
      defaultValue?: string;
    };

export interface ElicitationFormState {
  values: Record<string, string | string[] | boolean>;
  customValues: Record<string, string>;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractOptions(spec: JsonRecord | null): ElicitationOption[] {
  if (!spec) return [];
  const rawList = Array.isArray(spec.oneOf)
    ? spec.oneOf
    : Array.isArray(spec.anyOf)
      ? spec.anyOf
      : null;
  if (rawList) {
    const out: ElicitationOption[] = [];
    for (const entry of rawList) {
      const rec = asRecord(entry);
      if (!rec || rec.const === undefined) continue;
      const value = String(rec.const);
      const label = asString(rec.title) ?? value;
      const description = asString(rec.description);
      out.push({ value, label, ...(description ? { description } : {}) });
    }
    if (out.length) return out;
  }
  if (Array.isArray(spec.enum)) {
    const names = Array.isArray(spec.enumNames) ? spec.enumNames : [];
    return spec.enum.map((item, idx) => {
      const value = String(item);
      const label = asString(names[idx]) ?? value;
      return { value, label };
    });
  }
  return [];
}

function isSimpleStringProp(prop: JsonRecord | null): boolean {
  if (!prop) return false;
  if (prop.type !== 'string') return false;
  return !prop.oneOf && !prop.anyOf && !prop.enum;
}

export function parseElicitationSchema(schema: Record<string, unknown> | undefined | null): ElicitationField[] {
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  if (!properties) return [];
  const requiredSet = new Set(
    Array.isArray(root?.required) ? root.required.filter((item): item is string => typeof item === 'string') : []
  );

  const entries = Object.entries(properties);
  const consumed = new Set<string>();
  const fields: ElicitationField[] = [];

  for (const [key, rawProp] of entries) {
    if (consumed.has(key)) continue;
    const prop = asRecord(rawProp);
    if (!prop) continue;

    const title = asString(prop.title) ?? key;
    const description = asString(prop.description);
    const required = requiredSet.has(key);
    const propType = asString(prop.type);

    if (propType === 'array') {
      const items = asRecord(prop.items);
      const options = extractOptions(items);
      const siblingKey = `${key}_custom`;
      const siblingProp = asRecord(properties[siblingKey]);
      const hasCustom = isSimpleStringProp(siblingProp);
      if (hasCustom) consumed.add(siblingKey);
      const defaultValue = Array.isArray(prop.default)
        ? prop.default.map((item) => String(item))
        : undefined;
      fields.push({
        kind: 'multi_select',
        key,
        title,
        ...(description ? { description } : {}),
        required,
        options,
        ...(defaultValue ? { defaultValue } : {}),
        ...(hasCustom
          ? {
              customKey: siblingKey,
              customLabel: asString(siblingProp?.title),
              customPlaceholder: asString(siblingProp?.description)
            }
          : {})
      });
      continue;
    }

    const stringOptions = extractOptions(prop);
    if (stringOptions.length > 0) {
      const siblingKey = `${key}_custom`;
      const siblingProp = asRecord(properties[siblingKey]);
      const hasCustom = isSimpleStringProp(siblingProp);
      if (hasCustom) consumed.add(siblingKey);
      fields.push({
        kind: 'single_select',
        key,
        title,
        ...(description ? { description } : {}),
        required,
        options: stringOptions,
        ...(typeof prop.default === 'string' ? { defaultValue: prop.default } : {}),
        ...(hasCustom
          ? {
              customKey: siblingKey,
              customLabel: asString(siblingProp?.title),
              customPlaceholder: asString(siblingProp?.description)
            }
          : {})
      });
      continue;
    }

    if (propType === 'boolean') {
      fields.push({
        kind: 'boolean',
        key,
        title,
        ...(description ? { description } : {}),
        required,
        ...(typeof prop.default === 'boolean' ? { defaultValue: prop.default } : {})
      });
      continue;
    }

    if (propType === 'number' || propType === 'integer') {
      fields.push({
        kind: 'number',
        key,
        title,
        ...(description ? { description } : {}),
        required,
        isInteger: propType === 'integer',
        ...(typeof prop.default === 'number' ? { defaultValue: prop.default } : {})
      });
      continue;
    }

    fields.push({
      kind: 'text',
      key,
      title,
      ...(description ? { description } : {}),
      required,
      ...(typeof prop.default === 'string' ? { defaultValue: prop.default } : {})
    });
  }

  return fields;
}

export function initialElicitationState(fields: readonly ElicitationField[]): ElicitationFormState {
  const values: Record<string, string | string[] | boolean> = {};
  const customValues: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === 'multi_select') {
      values[field.key] = field.defaultValue ? [...field.defaultValue] : [];
      if (field.customKey) customValues[field.key] = '';
    } else if (field.kind === 'single_select') {
      values[field.key] = field.defaultValue ?? '';
      if (field.customKey) customValues[field.key] = '';
    } else if (field.kind === 'boolean') {
      values[field.key] = field.defaultValue ?? false;
    } else if (field.kind === 'number') {
      values[field.key] = field.defaultValue !== undefined ? String(field.defaultValue) : '';
    } else {
      values[field.key] = field.defaultValue ?? '';
    }
  }
  return { values, customValues };
}

export function validateElicitationAnswers(
  fields: readonly ElicitationField[],
  state: ElicitationFormState
): string | null {
  for (const field of fields) {
    if (!field.required) continue;
    if (field.kind === 'single_select') {
      const chosen = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string).trim() : '';
      const custom = (state.customValues[field.key] ?? '').trim();
      if (!chosen && !custom) return field.title;
    } else if (field.kind === 'multi_select') {
      const arr = Array.isArray(state.values[field.key]) ? (state.values[field.key] as string[]) : [];
      const custom = (state.customValues[field.key] ?? '').trim();
      if (!arr.length && !custom) return field.title;
    } else if (field.kind === 'boolean') {
      if (typeof state.values[field.key] !== 'boolean') return field.title;
    } else if (field.kind === 'number') {
      const raw = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string).trim() : '';
      if (!raw || !Number.isFinite(Number(raw))) return field.title;
    } else {
      const raw = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string).trim() : '';
      if (!raw) return field.title;
    }
  }
  return null;
}

export function buildElicitationContent(
  fields: readonly ElicitationField[],
  state: ElicitationFormState
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'single_select') {
      const custom = field.customKey ? (state.customValues[field.key] ?? '').trim() : '';
      const chosen = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string).trim() : '';
      if (custom && field.customKey) {
        content[field.customKey] = custom;
      } else if (chosen) {
        content[field.key] = chosen;
      }
    } else if (field.kind === 'multi_select') {
      const arr = Array.isArray(state.values[field.key]) ? (state.values[field.key] as string[]).filter(Boolean) : [];
      if (arr.length) content[field.key] = arr;
      const custom = field.customKey ? (state.customValues[field.key] ?? '').trim() : '';
      if (custom && field.customKey) content[field.customKey] = custom;
    } else if (field.kind === 'boolean') {
      if (typeof state.values[field.key] === 'boolean') {
        content[field.key] = state.values[field.key];
      }
    } else if (field.kind === 'number') {
      const raw = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string).trim() : '';
      if (raw && Number.isFinite(Number(raw))) {
        const parsed = Number(raw);
        content[field.key] = field.isInteger ? Math.trunc(parsed) : parsed;
      }
    } else {
      const raw = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string).trim() : '';
      if (raw) content[field.key] = raw;
    }
  }
  return content;
}
