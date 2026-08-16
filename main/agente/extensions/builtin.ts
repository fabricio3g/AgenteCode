// ── Built-in extensions ────────────────────────────────────────────────
// Written against the same public API any third-party extension would use
// (pi's dogfooding rule: if the API can't build these, the API is wrong).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgenteExtensionDefinition } from './extension-api.ts';

const execFileAsync = promisify(execFile);

/**
 * git_tools: read-only Git tooling the agent can call without shelling out.
 * Adds `git_status` and `git_diff` as plain parallel tools.
 */
export const gitToolsExtension: AgenteExtensionDefinition = {
  id: 'git-tools',
  name: 'Git Tools',
  description: 'Adds git_status and git_diff tools (read-only).',
  icon: 'git-branch',
  defaultEnabled: true,
  setup(pi) {
    const run = async (projectRoot: string, args: string[]) => {
      const { stdout } = await execFileAsync('git', args, {
        cwd: projectRoot,
        maxBuffer: 1024 * 1024,
        timeout: 15_000
      });
      return stdout || '(empty)';
    };

    pi.registerTool({
      name: 'git_status',
      description: 'Show the working tree status (git status --porcelain, plus branch info).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      executionMode: 'parallel',
      async execute(_args, ctx) {
        try {
          const [status, branch] = await Promise.all([
            run(ctx.projectRoot, ['status', '--porcelain']),
            run(ctx.projectRoot, ['branch', '--show-current'])
          ]);
          if (status === '(empty)') {
            return { content: `On branch ${branch.trim() || '(detached)'} — clean working tree.` };
          }
          return {
            content: `Branch: ${branch.trim() || '(detached)'}\n${status}`,
            details: { branch: branch.trim(), dirty: status !== '(empty)' }
          };
        } catch (err: unknown) {
          return { content: `git_status failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    });

    pi.registerTool({
      name: 'git_diff',
      description: 'Show uncommitted changes (git diff, optionally staged).',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes (--cached) instead of unstaged' }
        },
        additionalProperties: false
      },
      executionMode: 'parallel',
      async execute(args, ctx) {
        try {
          const diff = await run(ctx.projectRoot, ['diff', ...(args.staged ? ['--cached'] : []), '--stat', '-p', 'HEAD']);
          return {
            content: diff.length > 32_000 ? `${diff.slice(0, 32_000)}\n… (truncated)` : diff || '(no changes)',
            details: { staged: !!args.staged }
          };
        } catch (err: unknown) {
          return { content: `git_diff failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    });
  }
};

/**
 * safety_rails: hook-based policy — blocks tool calls matching destructive
 * command patterns before they ever reach the approval gate, and records
 * every run start into the session JSONL (extension state persistence).
 */
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-z]*r[a-z]*f?|[a-z]*f[a-z]*r)\b/i,
  /(?:^|\s|&&|\|\|)\s*mkfs\b/i,
  /\bgit\s+push\s+.*--force(?!-with-lease)/i,
  /\bdrop\s+(table|database)\b/i,
  /:\(\)\{\s*:\|:&\s*\};:/ // fork bomb
];

export const safetyRailsExtension: AgenteExtensionDefinition = {
  id: 'safety-rails',
  name: 'Safety Rails',
  description: 'Blocks destructive commands (force push, rm -rf, fork bombs) before execution.',
  icon: 'shield',
  defaultEnabled: true,
  setup(pi) {
    pi.on('tool_call', async (payload) => {
      if (payload.toolName !== 'bash') return;
      const command = String(payload.args?.command ?? '');
      for (const pattern of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(command)) {
          return { block: `safety-rails: command matches a destructive pattern (${pattern.source}). Refactor to a safer equivalent.` };
        }
      }
      return;
    });

    pi.on('before_agent_start', async (_payload, ctx) => {
      ctx.appendEntry('custom', { note: 'run_started', extension: ctx.extensionId, at: Date.now() });
    });
  }
};

export function createBuiltinExtensions(): AgenteExtensionDefinition[] {
  return [gitToolsExtension, safetyRailsExtension];
}
