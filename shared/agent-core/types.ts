// ── Agente core message model ──────────────────────────────────────────
// pi-inspired: one message union, OpenAI-wire compatible so the provider
// bridge is a thin mapper. Failures live inside AssistantMessage.stopReason,
// never in thrown exceptions — the loop can then react without try/catch
// gymnastics and the event stream stays the only side channel.

export interface CoreTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type StopReason = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';

export interface UserMessage {
  role: 'user';
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  ts: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: CoreTokenUsage | null;
  stopReason?: StopReason;
  errorMessage?: string;
  /** Stable classification from the provider protocol (AUTH, RATE_LIMIT, …). */
  errorCode?: string;
  /**
   * Opaque provider round-trip state (e.g. Gemini thought signatures).
   * Persisted with the session and echoed back on resume — required by
   * DeepSeek-class models that reject calls without it. Never serialized
   * onto the CodeAgentEvent wire.
   */
  providerState?: unknown;
  /** Provider-native reasoning channel, echoed for the same reason. */
  reasoning_content?: string;
  ts: number;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  /** Text returned to the model. */
  content: string;
  isError: boolean;
  /** Structured payload for the UI (diffs, file lists, exit codes). */
  details?: unknown;
  ts: number;
}

/** One entry of the model-maintained task list (the todo_write tool). */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

// ── Tools ──────────────────────────────────────────────────────────────

/** OpenAI function-tool shape handed to the LLM. */
export interface WireTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  /** Text sent back to the model. */
  content: string;
  isError?: boolean;
  /** Structured payload for the UI/logs — never sent to the model. */
  details?: unknown;
  /** Stop the whole run after this tool's batch completes. */
  terminate?: boolean;
}

export interface ToolExecContext {
  signal: AbortSignal;
  /** Streaming progress for long-running tools (tool_update events). */
  onUpdate?: (partial: unknown) => void;
  /** Side-channel for tools that announce state (todo_update). */
  emit?: (event: AgentEvent) => void;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Mutating tools go through the approval gate in supervised mode. */
  mutating?: boolean;
  /** Parallel-friendly tools run concurrently within a turn. */
  executionMode?: 'sequential' | 'parallel';
  execute(toolCallId: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResult>;
}

// ── Events (the loop's only side channel) ──────────────────────────────

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; stopReason: StopReason }
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'message_end'; message: AssistantMessage }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown; label?: string; detail?: string }
  | { type: 'tool_update'; toolCallId: string; toolName: string; partial: unknown }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      status?: 'done' | 'error';
      fileChanges?: Array<{ path: string; kind: string }>;
      diffStats?: Array<{ path: string; kind: string; additions: number; deletions: number }>;
    }
  | { type: 'llm_retry'; attempt: number; delayMs: number }
  | { type: 'length_continue'; turnIndex: number }
  | { type: 'todo_update'; todos: TodoItem[] }
  | { type: 'artifact_created'; artifact: CoreArtifactRef }
  | { type: 'artifact_list'; artifacts: CoreArtifactRef[] }
  | { type: 'sources'; sources: CoreSourceRef[] }
  | { type: 'sources_delta'; sources: CoreSourceRef[] }
  | { type: 'activity'; activity: CoreActivityKey }
  | { type: 'run_summary'; summary: CoreRunSummary }
  | { type: 'content_replace'; content: string }
  | { type: 'steer_acknowledged'; accepted: boolean; queuedCount?: number }
  | { type: 'error'; message: string };

/**
 * Core mirrors of the wire's Home-facing shapes. Defined locally (not
 * imported from ../agente-protocol): shared/agent-core may only import
 * itself — see tests/unit/agent-core-purity.test.js.
 */
export type CoreActivityKey =
  | 'planning'
  | 'searching'
  | 'reading'
  | 'creating_files'
  | 'writing'
  | 'stopped'
  | 'completed';

export interface CoreArtifactRef {
  kind: string;
  entryPath: string;
  title?: string;
  manifest?: unknown;
  workProduct?: unknown;
}

export interface CoreSourceRef {
  title: string;
  url: string;
  snippet?: string;
  full_content?: string;
  provider?: string;
}

export interface CoreRunSummary {
  outcome: 'completed' | 'partial' | 'stopped' | 'failed';
  homeStopReason: 'timeout' | 'loop' | 'tool_limit' | 'iteration_limit' | 'missing_artifacts' | 'error' | 'none';
  warning?: string;
  error?: string;
  publicFallback?: boolean;
  diagnosticsRedacted?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    contextWindow?: number;
    timings?: Record<string, number>;
  };
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

// ── LLM boundary (the only thing the loop knows about models) ──────────

export interface StreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface StreamRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: WireTool[];
  signal: AbortSignal;
  callbacks?: StreamCallbacks;
}

/**
 * The loop's single dependency on the LLM world. Providers, proxies, tests —
 * everything is just a StreamFn (pi's central design decision).
 */
export type StreamFn = (request: StreamRequest) => Promise<AssistantMessage>;
