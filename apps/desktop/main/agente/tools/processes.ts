// ── Tools over the agent's background processes ───────────────────────
// Companions to `bash` with background: true: read what a server printed,
// see what is running, stop it.

import { z } from 'zod';
import { defineTool } from './define-tool.ts';
import type { AgentTool } from '../../../shared/agent-core/types.ts';
import type { ProcessRegistry } from '../processes.ts';

function describe(info: ReturnType<ProcessRegistry['list']>[number]): string {
  const state = info.status === 'running' ? 'running' : `${info.status} (exit ${info.exitCode})`;
  return `${info.id} · ${state} · ${info.command}${info.urls.length ? ` · ${info.urls.join(', ')}` : ''}`;
}

export function createProcessTools(chatId: string, processes: ProcessRegistry): AgentTool[] {
  const owned = (id: string) => processes.list(chatId).find((p) => p.id === id);

  return [
    defineTool({
      name: 'process_list',
      description: 'List the background processes started in this conversation, with their status and URLs.',
      schema: z.object({}),
      executionMode: 'parallel',
      async execute() {
        const list = processes.list(chatId);
        return { content: list.length ? list.map(describe).join('\n') : 'No background processes.' };
      }
    }),
    defineTool({
      name: 'process_output',
      description: 'Read the recent output of a background process (server logs, build errors).',
      schema: z.object({
        id: z.string().describe('Process id from bash background or process_list'),
        tailChars: z.number().int().min(200).max(20_000).optional().describe('How much of the end to read (default 4000)')
      }),
      executionMode: 'parallel',
      async execute(args) {
        const info = owned(args.id);
        if (!info) return { content: `No process ${args.id} in this conversation.`, isError: true };
        const output = processes.output(args.id, args.tailChars ?? 4_000) ?? '';
        return { content: `${describe(info)}\n\n${output.trim() || '(no output yet)'}` };
      }
    }),
    defineTool({
      name: 'process_stop',
      description: 'Stop a background process and everything it started.',
      schema: z.object({ id: z.string().describe('Process id') }),
      mutating: true,
      executionMode: 'sequential',
      async execute(args) {
        if (!owned(args.id)) return { content: `No process ${args.id} in this conversation.`, isError: true };
        const stopped = await processes.stop(args.id);
        return { content: stopped ? `Stopped ${args.id}.` : `${args.id} had already exited.` };
      }
    })
  ];
}
