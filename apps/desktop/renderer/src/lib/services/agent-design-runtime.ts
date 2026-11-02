/**
 * A Design turn is a Home turn with different tools: the Rust runtime owns the
 * conversation, and this file swaps in the workspace-jailed design tools, the
 * design prompt and a longer budget. When the turn ends the design is saved as
 * a version.
 */
import type { AgentTool } from '$shared/agent-core/types';
import type { AgentTaskResult, RunAgentTaskArgs } from './agent-types';
import { invoke, listen } from './bridge';
import { runHomeRuntime, type SpaceRuntime } from './agent-home-runtime';
import { createHomeTools } from './agent-home-tools';
import type { AgentRun } from './agent-run-context';
import { uid } from './agent-tool-dispatch';
import { DESIGN_BORROWED_TOOLS, type DesignSystemBrief, type DesignToolResult } from '$shared/design';
import { copy } from '$lib/copy';
import { createDesignTools, type DesignToolHost } from '$lib/features/design/design-tools';
import { designStore } from '$lib/features/design/design.svelte';
import { systemBriefing } from '$lib/features/design/design-systems';
import { DESIGN_SYSTEM_PROMPT, DESIGN_3D_PROMPT, attachedReferencesBlock, designWorkspaceBriefing, matchReferencesBlock } from './design-prompts';
import { saveReferenceImages } from './design-references';
import { startDesignToolStep, finishDesignToolStep } from '$lib/features/design/design-tool-trace';
import type { BlenderState } from '$shared/design-3d';

/** A design turn writes several files and previews them at two widths; Home's budget is too tight for that. */
const DESIGN_BUDGET = { maxIterations: 60, maxToolCalls: 160, maxTimeMs: 20 * 60 * 1000 } as const;

function stepLabel(tool: string): string {
  if (tool === 'design_3d') return 'Blender';
  const labels = copy.design.steps as Record<string, string>;
  return labels[tool] ?? tool;
}

function emitDesignSteps(run: AgentRun) {
  // Publish snapshots: mutating raw step objects alone does not invalidate the
  // message's reactive proxies, especially while Blender streams its log.
  run.args.onStep(run.steps.map(step => ({ ...step })));
}

function toolHost(run: AgentRun, chatId: string): DesignToolHost {
  let vision: Promise<boolean> | undefined;
  return {
    chatId,
    // The outer tool wrapper owns one trace per call, including early refusals.
    step() { return () => {}; },
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

function tracedDesignTools(run: AgentRun, chatId: string, tools: Map<string, AgentTool>): Map<string, AgentTool> {
  return new Map<string, AgentTool>([...tools].map(([name, tool]) => [name, !name.startsWith('design_') ? tool : {
    ...tool,
    async execute(...[id, args, context]: Parameters<AgentTool['execute']>) {
      const step = startDesignToolStep(uid('design-tool'), name, stepLabel(name), args);
      run.steps.push(step); emitDesignSteps(run);
      let off: (() => void) | undefined;
      let finished = false, reading = false, lastRead = 0;
      try {
        if (name === 'design_3d') {
          off = await listen<{chatId:string}>('design_3d_changed', event => {
            if (finished || event.chatId !== chatId || context.signal.aborted || reading || Date.now() - lastRead < 1000) return;
            reading = true; lastRead = Date.now();
            void invoke<BlenderState>('design_3d', {chatId, action:'status'}).then(state => {
              if (finished || context.signal.aborted) return;
              if (state.log) { step.output = state.log.slice(-32_768); emitDesignSteps(run); }
            }).catch(() => {}).finally(() => { reading = false; });
          });
        }
        const result = await tool.execute(id, args, context);
        const liveLog = step.output;
        finishDesignToolStep(step, context.signal.aborted ? 'Stopped.' : [result.content, liveLog].filter(Boolean).join('\n\n'), !!result.isError || context.signal.aborted);
        return result;
      } catch (error) {
        finishDesignToolStep(step, context.signal.aborted ? 'Stopped.' : String(error), true);
        throw error;
      } finally { finished = true; off?.(); emitDesignSteps(run); }
    }
  }]));
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
      return tracedDesignTools(run, chatId, createDesignTools(toolHost(run, chatId), borrowed));
    },
    // The end of a turn is a version, whether it finished, failed or was stopped.
    finished: async () => { await invoke('design_manage', { chatId, action: 'snapshot', auto: true, label: (args.rawPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 60) }); }
  };
  return runHomeRuntime({ ...args, ...DESIGN_BUDGET, noTools: false, toolMode: 'agent', agentProfile: 'chat' }, space);
}
