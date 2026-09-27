// ── Tool definition helper ─────────────────────────────────────────────
// zod in, JSON Schema + validated execute out — the same pattern as the
// renderer's artifact registry, so a future external loader can accept
// identical definitions.

import path from 'node:path';
import { z } from 'zod';
import type { AgentTool, ToolExecContext, ToolResult } from '../../../shared/agent-core/types.ts';

export interface ToolDefinitionInput<T extends z.ZodType> {
  name: string;
  description: string;
  schema: T;
  mutating?: boolean;
  /** Ask for approval on this particular call (see AgentTool.requiresApproval). */
  requiresApproval?(args: z.output<T>): boolean;
  executionMode?: 'sequential' | 'parallel';
  execute(args: z.output<T>, ctx: ToolExecContext, toolCallId: string): Promise<ToolResult>;
}

export function defineTool<T extends z.ZodType>(input: ToolDefinitionInput<T>): AgentTool {
  const json = z.toJSONSchema(input.schema, { target: 'draft-07' }) as Record<string, unknown>;
  delete json.$schema;
  return {
    name: input.name,
    description: input.description,
    parameters: json,
    mutating: input.mutating,
    ...(input.requiresApproval
      ? {
          requiresApproval: (rawArgs: Record<string, unknown>) => {
            const parsed = input.schema.safeParse(rawArgs ?? {});
            return parsed.success ? input.requiresApproval!(parsed.data) : false;
          }
        }
      : {}),
    executionMode: input.executionMode,
    async execute(toolCallId, rawArgs, ctx) {
      const parsed = input.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return {
          content: `Invalid arguments for ${input.name}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
            .join('; ')}`,
          isError: true
        };
      }
      return input.execute(parsed.data, ctx, toolCallId);
    }
  };
}

/**
 * Resolve a model-supplied path inside the project root. Absolute paths are
 * accepted only when they live under the root; `..` walks and symlinked
 * escapes are rejected. This is the boundary every filesystem tool goes
 * through — never `path.resolve` directly.
 */
export function resolveInRoot(projectRoot: string, relative: string): string {
  const root = path.resolve(projectRoot);
  const abs = path.isAbsolute(relative) ? path.resolve(relative) : path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path "${relative}" escapes the project root`);
  }
  return abs;
}
