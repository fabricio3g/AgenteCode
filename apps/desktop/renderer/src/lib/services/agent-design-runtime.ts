/**
 * A Design turn is a Home turn with different tools: the Rust runtime owns the
 * conversation, and this file swaps in the workspace-jailed design tools, the
 * design prompt and a longer budget. When the turn ends the design is saved as
 * a version.
 */
import type { AgentTool } from '$shared/agent-core/types';
import type { AgentStep } from '$lib/types/chat';
import type { AgentTaskResult, RunAgentTaskArgs } from './agent-types';
import { invoke } from './bridge';
import { runHomeRuntime, type SpaceRuntime } from './agent-home-runtime';
import { createHomeTools } from './agent-home-tools';
import { emitSteps, type AgentRun } from './agent-run-context';
import { uid } from './agent-tool-dispatch';
import { DESIGN_BORROWED_TOOLS, type DesignSystemBrief, type DesignToolResult } from '$shared/design';
import { copy } from '$lib/copy';
import { createDesignTools, type DesignToolHost } from '$lib/features/design/design-tools';
import { designStore } from '$lib/features/design/design.svelte';
import { systemBriefing } from '$lib/features/design/design-systems';
import { DESIGN_SYSTEM_PROMPT, DESIGN_3D_PROMPT, attachedReferencesBlock, designWorkspaceBriefing, matchReferencesBlock } from './design-prompts';
import { saveReferenceImages } from './design-references';

/** A design turn writes several files and previews them at two widths; Home's budget is too tight for that. */
const DESIGN_BUDGET = { maxIterations: 60, maxToolCalls: 160, maxTimeMs: 20 * 60 * 1000 } as const;

const STEP_TYPE: Record<string, AgentStep['type']> = {
  design_list: 'reading', design_read: 'reading', design_write: 'writing', design_edit: 'writing',
  design_snapshot: 'tool', design_preview: 'preview', design_inspect: 'reading', design_motion: 'preview',
  design_reference: 'searching', design_view: 'reading'
};

function stepLabel(tool: string): string {
  const labels = copy.design.steps as Record<string, string>;
  return labels[tool] ?? tool;
}

function toolHost(run: AgentRun, chatId: string): DesignToolHost {
  let vision: Promise<boolean> | undefined;
  return {
    chatId,
    step(tool, detail) {
      const step: AgentStep = { id: uid('step'), type: STEP_TYPE[tool] || 'tool', toolName: tool, label: stepLabel(tool), detail: detail || undefined, status: 'running', startedAt: Date.now() };
      run.steps.push(step);
      emitSteps(run);
      return (ok, note) => {
        step.status = ok ? 'done' : 'error';
        step.durationMs = Date.now() - (step.startedAt ?? Date.now());
        if (note) step.detail = note.slice(0, 200);
        emitSteps(run);
      };
    },
    count() { run.totalToolCalls += 1; },
    vision() {
      const plan = run.plan;
      vision ??= invoke<string[]>('agente_model_inputs', { provider: plan.localMode ? 'local' : plan.providerName, model: plan.activeModel })
        .then((kinds) => Array.isArray(kinds) && kinds.includes('image'))
        .catch(() => false);
      return vision;
    }
  };
}

/** The listing plus DESIGN.md and tokens.css, so the first call is design work and not orientation. */
async function briefing(chatId: string): Promise<string> {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try { return await invoke<DesignToolResult>('design_tool', { chatId, name, args }); } catch { return { ok: false, content: '' }; }
  };
  const [listing, designMd, tokens] = await Promise.all([call('design_list'), call('design_read', { path: 'DESIGN.md' }), call('design_read', { path: 'tokens.css' })]);
  return designWorkspaceBriefing(listing.ok ? listing.content : '', designMd.ok ? designMd.content : '', tokens.ok ? tokens.content : '');
}

/** The design system the design is linked to, read from the library rather than the design's copies, which may be older. */
async function systemBrief(chatId: string): Promise<string> {
  try {
    return systemBriefing(await invoke<DesignSystemBrief | null>('design_systems', { action: 'brief', chatId }));
  } catch {
    return '';
  }
}

export function captureDesignTurnContext(chatId: string): NonNullable<RunAgentTaskArgs['designContext']> {
  return designStore.chatId === chatId
    ? { selection: designStore.takeTurnContext(), references: designStore.references.map(item => item.path) }
    : { selection: '', references: [] };
}

export async function runDesignTask(args: RunAgentTaskArgs): Promise<AgentTaskResult> {
  const chatId = args.chatId;
  // What the user pointed at on the canvas belongs to this send, so take it before any await.
  const context = args.designContext ?? captureDesignTurnContext(chatId);
  // Images sent with this message become references first, so the briefing lists them.
  const attachedPaths = await saveReferenceImages(chatId, args.messages);
  const attached = attachedReferencesBlock(attachedPaths);
  // The canvas may now show another design. Its state cannot change this run's brief.
  const matching = matchReferencesBlock(context.references, attachedPaths);
  const space: SpaceRuntime = {
    systemPrompt: [DESIGN_SYSTEM_PROMPT, DESIGN_3D_PROMPT, await briefing(chatId), await systemBrief(chatId), context.selection, matching, attached].filter(Boolean).join('\n\n'),
    tools(run) {
      // Only read-only web access is borrowed from Home; the names are an allow-list.
      const home = createHomeTools(run, true).tools;
      const borrowed = new Map<string, AgentTool>([...home].filter(([name]) => (DESIGN_BORROWED_TOOLS as readonly string[]).includes(name)));
      return createDesignTools(toolHost(run, chatId), borrowed);
    },
    // The end of a turn is a version, whether it finished, failed or was stopped.
    finished: async () => { await invoke('design_manage', { chatId, action: 'snapshot', auto: true, label: (args.rawPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 60) }); }
  };
  return runHomeRuntime({ ...args, ...DESIGN_BUDGET, noTools: false, toolMode: 'agent', agentProfile: 'chat' }, space);
}
