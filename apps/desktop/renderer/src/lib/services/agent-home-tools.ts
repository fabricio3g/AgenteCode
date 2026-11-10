/**
 * Home's tools as shared agent-core tools.
 *
 * The core loop decides when a tool runs; each tool here does what a Home
 * tool call has always done around the handler: a live step in the activity
 * list, the timeout/retry policy, source merging, artifact publishing and the
 * evidence observation. The model-facing text is the capped JSON payload.
 */

import type { AgentTool, ToolResult as CoreToolResult } from '$shared/agent-core/types';
import type { ToolCall } from '$lib/services/agent-types';
import { STEP_TYPE } from '$lib/services/agent-tooling';
import { summarizeToolObservation } from '$lib/services/agent-evidence';
import {
  createRunningToolStep,
  displayToolLabel,
  finalizeToolStep,
  mergeWebSearchSources,
  recoverOptionalPresentationFailure,
  toolResultPayload
} from '$lib/services/agent-tool-result';
import { executeToolWithTimeout, uid } from '$lib/services/agent-tool-dispatch';
import { emitSteps, publishToolArtifact, type AgentRun, type HomeToolDetails } from '$lib/services/agent-run-context';

const MAX_TOOL_RESULT_CHARS = 12000;
/** Must run after the writes in the same turn (they build what it previews). */
const SEQUENTIAL_TOOLS = new Set(['preview_project']);
/** Tools the loop itself issues when it turns website code blocks into files. */
const LOOP_ISSUED_TOOLS = ['write_file', 'preview_project'];

function homeTool(run: AgentRun, definition: { name: string; description: string; parameters: Record<string, unknown> }): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    executionMode: SEQUENTIAL_TOOLS.has(definition.name) ? 'sequential' : 'parallel',
    async execute(toolCallId, args, execution): Promise<CoreToolResult> {
      const { args: runArgs, ctx } = run;
      const call: ToolCall = { id: toolCallId, name: definition.name, arguments: args };
      runArgs.onProgress?.(`${displayToolLabel(call.name)}…`);
      const step = createRunningToolStep(call, STEP_TYPE, uid);
      run.steps.push(step);
      emitSteps(run);

      const result = recoverOptionalPresentationFailure(call, await executeToolWithTimeout(call.name, args, { ...ctx, signal: execution.signal }));
      execution.signal.throwIfAborted();
      ctx.signal?.throwIfAborted();
      run.observations.push(summarizeToolObservation(call.name, args, result));
      mergeWebSearchSources({ toolCall: call, result, sources: run.sources, seenUrls: run.seenUrls, onSources: runArgs.onSources });
      finalizeToolStep(step, result, call.name);
      publishToolArtifact(run, result);
      emitSteps(run);
      // Previews are free: they only render what the writes already built.
      if (call.name !== 'preview_project') run.totalToolCalls += 1;

      const payload = toolResultPayload(result, MAX_TOOL_RESULT_CHARS);
      const details: HomeToolDetails = { payload };
      // Screenshots ride as images; the wire builder attaches them for vision models.
      return { content: JSON.stringify(payload), isError: !result.success, details, ...(result.image ? { images: [result.image] } : {}) };
    }
  };
}

/** Every tool the model is offered, plus the ones the loop issues on its behalf. */
export function createHomeTools(run: AgentRun, runtime = false): { tools: Map<string, AgentTool>; enabled: Set<string> } {
  const definitions = run.plan.toolDefs.map((tool) => tool.function);
  const tools = new Map<string, AgentTool>();
  for (const definition of definitions) {
    tools.set(definition.name, homeTool(run, definition as { name: string; description: string; parameters: Record<string, unknown> }));
  }
  if (runtime && run.args.onReaction) {
    const reactions = ['👍', '❤️', '😊', '🎉', '🤔', '👀', '😂', '😮', '🙏', '✅', '💡', '💪'];
    tools.set('react_to_message', {
      name: 'react_to_message',
      description: 'Optionally react to the latest user message with one emoji when it fits. You may skip this tool. Never use it in place of answering.',
      parameters: { type: 'object', properties: { emoji: { type: 'string', enum: reactions } }, required: ['emoji'] },
      executionMode: 'sequential',
      async execute(_id, args, execution) {
        execution.signal.throwIfAborted();
        const emoji = typeof args.emoji === 'string' ? args.emoji : '';
        if (!reactions.includes(emoji)) return { content: 'Choose one of the offered emoji.', isError: true };
        return run.args.onReaction?.(emoji)
          ? { content: 'Reaction added.' }
          : { content: 'The user message is no longer available.', isError: true };
      }
    });
  }
  for (const name of runtime ? [] : LOOP_ISSUED_TOOLS) {
    if (!tools.has(name)) tools.set(name, homeTool(run, { name, description: name, parameters: { type: 'object' } }));
  }
  return { tools, enabled: new Set(tools.keys()) };
}
