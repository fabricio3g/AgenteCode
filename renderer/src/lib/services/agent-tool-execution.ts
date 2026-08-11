import type { AgentStep } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';
import type { ToolCall, ToolObservation, ToolResult } from '$lib/services/agent-types';
import {
  appendToolResultMessage,
  createRunningToolStep,
  displayToolLabel,
  finalizeToolStep,
  mergeWebSearchSources,
  recoverOptionalPresentationFailure
} from '$lib/services/agent-tool-result';

export async function executeSingleTool(params: {
  tc: ToolCall;
  steps: AgentStep[];
  args: {
    onProgress?: (text: string) => void;
    onStep: (steps: AgentStep[]) => void;
    onSources?: (sources: SearchResult[]) => void;
  };
  ctx: { signal?: AbortSignal };
  messages: RequestMessage[];
  sources: SearchResult[];
  seenUrls: Set<string>;
  observations: ToolObservation[];
  nativeActive: boolean;
  nativeFailed: boolean;
  stepTypeMap: Record<string, AgentStep['type']>;
  uid: (prefix: string) => string;
  executeToolWithTimeout: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  summarizeToolObservation: (name: string, args: Record<string, unknown>, result: ToolResult) => ToolObservation;
  /** Publishes the artifact this one tool call produced. See `buildScopedArtifact`. */
  publishToolArtifact: (result: ToolResult) => void;
  maxToolResultChars: number;
}): Promise<boolean> {
  const {
    tc, steps, args, ctx, messages, sources, seenUrls, observations,
    nativeActive, stepTypeMap, uid, executeToolWithTimeout,
    summarizeToolObservation, publishToolArtifact, maxToolResultChars
  } = params;
  let nativeFailed = params.nativeFailed;

  args.onProgress?.(`${displayToolLabel(tc.name)}…`);
  const toolStep = createRunningToolStep(tc, stepTypeMap, uid);
  steps.push(toolStep);
  args.onStep([...steps]);

  let result = await executeToolWithTimeout(tc.name, tc.arguments);
  result = recoverOptionalPresentationFailure(tc, result);
  observations.push(summarizeToolObservation(tc.name, tc.arguments, result));

  mergeWebSearchSources({ toolCall: tc, result, sources, seenUrls, onSources: args.onSources });
  finalizeToolStep(toolStep, result, tc.name);
  publishToolArtifact(result);
  args.onStep([...steps]);
  appendToolResultMessage({ toolCall: tc, result, messages, nativeActive, nativeFailed, maxToolResultChars });

  /*
   * The abort check comes last, after the result has been recorded. It used to sit
   * immediately after the tool returned, which threw away work that had already
   * completed *and* left the assistant's `tool_calls` block unpaired — so resuming or
   * retrying that chat sent malformed history to the provider. The tool has run
   * either way; the only question is whether the loop continues.
   */
  ctx.signal?.throwIfAborted?.();

  return nativeFailed;
}
