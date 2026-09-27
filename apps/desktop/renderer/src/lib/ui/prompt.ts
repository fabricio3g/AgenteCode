import { z } from 'zod';
import type { Library, PromptOptions } from './library';

const PREAMBLE = 'You are an AI assistant that responds using ui-lang, a declarative UI language. Your entire response must be valid ui-lang code only.';

function getZodDef(schema: unknown): any {
  return (schema as any)?._zod?.def;
}

function getZodType(schema: unknown): string | undefined {
  return getZodDef(schema)?.type;
}

function isOptionalType(schema: unknown): boolean {
  return getZodType(schema) === 'optional';
}

function unwrap(schema: unknown): unknown {
  const def = getZodDef(schema);
  return def?.type === 'optional' ? def.innerType : schema;
}

function getSchemaId(schema: unknown): string | undefined {
  try {
    return z.globalRegistry.get(schema as z.ZodType)?.id;
  } catch {
    return undefined;
  }
}

function resolveType(schema: unknown): string {
  const inner = unwrap(schema);
  const id = getSchemaId(inner);
  if (id) return id;
  const type = getZodType(inner);
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return `${resolveType(getZodDef(inner)?.element ?? getZodDef(inner)?.innerType)}[]`;
  if (type === 'enum') {
    const values = getZodDef(inner)?.values;
    if (Array.isArray(values)) return values.map((value: string) => `"${value}"`).join(' | ');
  }
  if (type === 'object') {
    const shape = getZodDef(inner)?.shape || {};
    return `{ ${Object.entries(shape).map(([key, value]) => `${key}${isOptionalType(value) ? '?' : ''}: ${resolveType(value)}`).join(', ')} }`;
  }
  return 'any';
}

export function generatePrompt(library: Library, options?: PromptOptions): string {
  const rootName = library.root || 'Card';
  const componentLines = Object.values(library.components).map((component) => {
    const fields = Object.entries(component.props.shape).map(([name, schema]) => `${name}${isOptionalType(schema) ? '?' : ''}: ${resolveType(schema)}`);
    return `- ${component.name}(${fields.join(', ')})${component.description ? ` - ${component.description}` : ''}`;
  });
  const sections = [
    options?.preamble || PREAMBLE,
    '',
    'Syntax rules:',
    `- Start with root = ${rootName}(...)`,
    '- One statement per line: name = Expression',
    '- Use only strings, numbers, booleans, arrays, objects, references, and component calls',
    '- Use double quotes for strings',
    '- Output only ui-lang code',
    '',
    'Components:',
    ...componentLines
  ];
  if (options?.additionalRules?.length) sections.push('', 'Additional rules:', ...options.additionalRules.map((rule) => `- ${rule}`));
  if (options?.examples?.length) sections.push('', 'Examples:', ...options.examples);
  return sections.join('\n');
}
