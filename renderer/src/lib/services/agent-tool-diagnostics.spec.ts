import { describe, expect, it } from 'vitest';
import { parseDiagnosticLines } from '$lib/services/agent-tool-diagnostics';

describe('parseDiagnosticLines', () => {
  it('parses TypeScript compiler output', () => {
    const text = [
      `src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `src/app.ts(20,1): warning TS6133: 'x' is declared but its value is never read.`
    ].join('\n');
    const items = parseDiagnosticLines(text, 'tsc');
    expect(items).toHaveLength(2);
    expect(items[0].file).toContain('src/app.ts');
    expect(items[0].line).toBe(12);
    expect(items[0].severity).toBe('error');
    expect(items[0].message).toContain('TS2322');
    expect(items[1].severity).toBe('warning');
  });

  it('parses ruff-style lines', () => {
    const items = parseDiagnosticLines('app.py:3:1: F401 `os` imported but unused', 'ruff');
    expect(items).toHaveLength(1);
    expect(items[0].file).toBe('app.py');
    expect(items[0].line).toBe(3);
    expect(items[0].message).toContain('F401');
  });

  it('returns empty for noise', () => {
    expect(parseDiagnosticLines('Found 0 errors. Watching for file changes.', 'tsc')).toHaveLength(0);
  });
});
