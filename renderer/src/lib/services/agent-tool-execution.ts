import type { AgentArtifact, AgentStep } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';
import type { ToolCall, ToolObservation, ToolResult } from '$lib/services/agent-types';
import {
  applyNextTurnMods,
  appendToolResultMessage,
  createRunningToolStep,
  displayToolLabel,
  finalizeToolStep,
  mergeWebSearchSources,
  publishArtifact
} from '$lib/services/agent-tool-result';

export async function executeSingleTool(params: {
  tc: ToolCall;
  steps: AgentStep[];
  args: {
    onProgress?: (text: string) => void;
    onStep: (steps: AgentStep[]) => void;
    onArtifact: (artifact: AgentArtifact | null) => void;
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
  buildArtifact: () => AgentArtifact | null;
  maxToolResultChars: number;
}): Promise<boolean> {
  const {
    tc, steps, args, ctx, messages, sources, seenUrls, observations,
    nativeActive, stepTypeMap, uid, executeToolWithTimeout,
    summarizeToolObservation, buildArtifact, maxToolResultChars
  } = params;
  let nativeFailed = params.nativeFailed;

  args.onProgress?.(`${displayToolLabel(tc.name)}…`);
  const toolStep = createRunningToolStep(tc, stepTypeMap, uid);
  steps.push(toolStep);
  args.onStep([...steps]);

  const result = await executeToolWithTimeout(tc.name, tc.arguments);
  ctx.signal?.throwIfAborted?.();
  observations.push(summarizeToolObservation(tc.name, tc.arguments, result));

  if (applyNextTurnMods(messages, result)) {
    nativeFailed = true;
  }
  mergeWebSearchSources({ toolCall: tc, result, sources, seenUrls, onSources: args.onSources });
  finalizeToolStep(toolStep, result);
  publishArtifact(args.onArtifact, buildArtifact);
  args.onStep([...steps]);
  appendToolResultMessage({ toolCall: tc, result, messages, nativeActive, nativeFailed, maxToolResultChars });

  return nativeFailed;
}
