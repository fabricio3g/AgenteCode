import type { ToolContext, ToolResult } from '$lib/services/agent-types';
import { invoke } from '$lib/services/bridge';
import { pathExists } from '$lib/services/files';

export type DiagnosticItem = {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
};

const MAX_DIAGNOSTICS = 80;
const MAX_OUTPUT_CHARS = 12000;
const DIAG_TIMEOUT_MS = 45000;

function joinRoot(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '');
  const part = rel.replace(/^[\\/]+/, '');
  return part ? `${base}/${part}`.replace(/\\/g, '/') : base;
}

async function hasFile(root: string, rel: string): Promise<boolean> {
  try {
    return await pathExists(joinRoot(root, rel));
  } catch {
    return false;
  }
}

async function runShell(
  workspaceRoot: string,
  command: string,
  timeoutMs = DIAG_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  return invoke<{ stdout: string; stderr: string; exit_code: number }>('workspace_exec', {
    workspace_root: workspaceRoot,
    command,
    args: [],
    shell: true,
    timeout_ms: timeoutMs
  });
}

/** Parse TypeScript/ESLint-like "file(line,col): error TS123: message" and "file:line:col: message" */
export function parseDiagnosticLines(text: string, source: string): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  const lines = text.split(/\r?\n/);
  const tsRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+([^:]+):\s*(.+)$/i;
  const colonRe = /^(.+?):(\d+):(\d+):\s*(error|warning|info)?\s*(.*)$/i;
  const ruffRe = /^(.+?):(\d+):(\d+):\s+([A-Z]\d+)\s+(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let m = trimmed.match(tsRe);
    if (m) {
      items.push({
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]) || 1,
        col: Number(m[3]) || 1,
        severity: (m[4].toLowerCase() as DiagnosticItem['severity']) || 'error',
        message: `${m[5]}: ${m[6]}`.trim(),
        source
      });
      continue;
    }

    m = trimmed.match(ruffRe);
    if (m) {
      items.push({
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]) || 1,
        col: Number(m[3]) || 1,
        severity: 'error',
        message: `${m[4]} ${m[5]}`.trim(),
        source: 'ruff'
      });
      continue;
    }

    m = trimmed.match(colonRe);
    if (m && /\.[a-zA-Z0-9]+$/.test(m[1].split(/[\\/]/).pop() || '')) {
      const sev = (m[4] || 'error').toLowerCase();
      items.push({
        file: m[1].replace(/\\/g, '/'),
        line: Number(m[2]) || 1,
        col: Number(m[3]) || 1,
        severity: sev === 'warning' || sev === 'info' ? sev : 'error',
        message: (m[5] || trimmed).trim(),
        source
      });
    }
  }

  return items.slice(0, MAX_DIAGNOSTICS);
}

function formatDiagnostics(items: DiagnosticItem[], notes: string[]): string {
  if (!items.length) {
    return [
      'No diagnostics reported.',
      ...notes.map((n) => `- ${n}`),
      'If you expected errors, the project toolchain may be missing — install TypeScript/ESLint/Ruff or run checks via bash.'
    ].join('\n');
  }
  const errors = items.filter((i) => i.severity === 'error').length;
  const warnings = items.filter((i) => i.severity === 'warning').length;
  const lines = [
    `Found ${items.length} diagnostic(s) (${errors} error(s), ${warnings} warning(s)).`,
    ...notes.map((n) => `Note: ${n}`),
    '',
    ...items.map(
      (i) =>
        `${i.severity.toUpperCase()} ${i.file}:${i.line}:${i.col} [${i.source}] ${i.message}`
    )
  ];
  let out = lines.join('\n');
  if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS) + '\n… (truncated)';
  return out;
}

export async function handleGetDiagnostics(input: {
  args: Record<string, unknown>;
  ctx: ToolContext;
  ok: (output?: unknown, extra?: Partial<ToolResult>) => ToolResult;
  fail: (error: string, note?: string) => ToolResult;
}): Promise<ToolResult> {
  const { args, ctx, ok, fail } = input;
  if (ctx.executionMode !== 'workspace' || !ctx.workspaceRoot) {
    return fail('get_diagnostics is only available in a Code project workspace');
  }

  const root = ctx.workspaceRoot;
  const scopePath = typeof args.path === 'string' ? args.path.replace(/\\/g, '/').replace(/^\//, '') : '';
  const force = typeof args.language === 'string' ? args.language.toLowerCase() : '';

  const notes: string[] = [];
  const all: DiagnosticItem[] = [];

  const hasTsconfig = await hasFile(root, 'tsconfig.json');
  const hasPackage = await hasFile(root, 'package.json');
  const hasPyproject = (await hasFile(root, 'pyproject.toml')) || (await hasFile(root, 'ruff.toml'));
  const hasPython = force === 'python' || hasPyproject || scopePath.endsWith('.py');

  const wantTs = !force || force === 'typescript' || force === 'ts' || force === 'javascript' || force === 'js';
  const wantPy = !force || force === 'python' || force === 'py';

  try {
    if (wantTs && (hasTsconfig || hasPackage || force)) {
      if (hasTsconfig || force === 'typescript' || force === 'ts') {
        try {
          const result = await runShell(root, 'npx --yes tsc --noEmit --pretty false', DIAG_TIMEOUT_MS);
          const text = `${result.stdout || ''}\n${result.stderr || ''}`;
          const parsed = parseDiagnosticLines(text, 'tsc');
          all.push(...parsed);
          if (!parsed.length && result.exit_code === 0) notes.push('tsc: clean');
          else if (!parsed.length && result.exit_code !== 0) notes.push('tsc: exited with errors but no parseable lines');
        } catch (e) {
          notes.push(`tsc unavailable: ${String((e as Error)?.message || e)}`);
        }
      } else {
        notes.push('No tsconfig.json — skipped tsc (pass language:"typescript" to force)');
      }

      if (scopePath && (scopePath.endsWith('.ts') || scopePath.endsWith('.tsx') || scopePath.endsWith('.js') || scopePath.endsWith('.jsx'))) {
        try {
          const result = await runShell(
            root,
            `npx --yes eslint ${JSON.stringify(scopePath)} --format unix`,
            30000
          );
          const text = `${result.stdout || ''}\n${result.stderr || ''}`;
          all.push(...parseDiagnosticLines(text, 'eslint'));
        } catch {
          notes.push('eslint skipped or unavailable for scoped path');
        }
      }
    }

    if (wantPy && hasPython) {
      try {
        const target = scopePath ? JSON.stringify(scopePath) : '.';
        const result = await runShell(root, `npx --yes --package ruff ruff check ${target}`, 30000);
        const text = `${result.stdout || ''}\n${result.stderr || ''}`;
        const parsed = parseDiagnosticLines(text, 'ruff');
        if (parsed.length) all.push(...parsed);
        else {
          // try ruff on PATH
          try {
            const r2 = await runShell(root, `ruff check ${target}`, 30000);
            all.push(...parseDiagnosticLines(`${r2.stdout || ''}\n${r2.stderr || ''}`, 'ruff'));
          } catch {
            notes.push('ruff unavailable');
          }
        }
      } catch (e) {
        notes.push(`python diagnostics: ${String((e as Error)?.message || e)}`);
      }
    }

    if (!hasTsconfig && !hasPackage && !hasPython && !force) {
      return ok(
        {
          diagnostics: [],
          summary:
            'No TypeScript (tsconfig/package.json) or Python (pyproject/ruff) toolchain detected. Install tooling or run checks via bash.'
        },
        { note: 'no toolchain' }
      );
    }

    // Dedupe by file:line:col:message
    const seen = new Set<string>();
    const unique = all.filter((item) => {
      const key = `${item.file}:${item.line}:${item.col}:${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const summary = formatDiagnostics(unique, notes);
    return ok({ diagnostics: unique, count: unique.length, summary }, { note: summary.slice(0, 200) });
  } catch (error) {
    return fail(String((error as Error)?.message || error || 'Diagnostics failed'));
  }
}
