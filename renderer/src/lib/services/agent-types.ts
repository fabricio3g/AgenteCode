import type { AgentArtifact, AgentOutcome, AgentStep, AgentStopReason, ArtifactManifest, ReasoningLevel, WorkspaceFile } from '$lib/types/chat';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/bridge';

export type ToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  success: boolean;
  output?: unknown;
  /** An image for vision models (browser screenshots); never serialized into the text payload. */
  image?: { data: string; mimeType: string };
  error?: string;
  note?: string;
  createdFiles?: string[];
  modifiedFiles?: string[];
  deletedFiles?: string[];
  /**
   * Set by tools that produce an artifact, describing what they just made.
   * It rides on the *result* rather than on `ToolContext` deliberately: when it
   * lived on the context, `dispatchArtifactTool` left it set after a successful
   * call, so the next tool to build an artifact from the same context inherited a
   * manifest describing someone else's work — a weather card claiming to be a
   * chart. Per-result means it cannot outlive the call that produced it.
   */
  artifactManifest?: ArtifactManifest;
};

export type ToolObservation = {
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  summary: string;
  sources?: SearchResult[];
  createdFiles?: string[];
};

export type ToolContext = {
  chatId: string;
  files: Record<string, string>;
  conversationContext?: string;
  searchMode?: 'search' | 'deep' | 'max';
  /** Live sources gathered during the agent run (shared reference). */
  sources?: SearchResult[];
  rawPrompt?: string;
  workspaceRoot?: string;
  workspaceFiles?: WorkspaceFile[];
  executionMode: 'sandbox' | 'workspace';
  runtimeMode?: 'full' | 'supervised';
  debugLogs?: boolean;
  signal?: AbortSignal;
  workProduct?: AgentArtifact['workProduct'];
  /**
   * Per-type artifact enable switches, so the dispatcher can refuse a disabled type
   * at execution time. Filtering the advertised tool list is not enough on its own:
   * a model working from earlier context can still emit `create_map` after maps were
   * turned off.
   */
  artifactToggles?: Record<string, boolean>;
};

export type AgentTaskResult = {
  content: string;
  reasoning: string;
  steps: AgentStep[];
  /** The last artifact the turn produced. Kept for callers that only show one. */
  artifact: AgentArtifact | null;
  /** Every artifact the turn produced, in creation order. */
  artifacts: AgentArtifact[];
  sources: SearchResult[];
  outcome: AgentOutcome;
  stopReason: AgentStopReason;
  publicFallback?: boolean;
  diagnosticsRedacted?: boolean;
  error?: string;
  warning?: string;
  usage?: CompletionResult['usage'];
};

export type RunAgentTaskArgs = {
  chatId: string;
  systemPrompt?: string;
  messages: RequestMessage[];
  rawPrompt?: string;
  conversationContext?: string;
  executionMode?: 'workspace' | 'sandbox';
  workspaceRoot?: string;
  workspaceName?: string;
  workspaceFiles?: WorkspaceFile[];
  /**
   * Accepts the engine's plan mode but executes it as supervised (see
   * normalizeHomeRuntimeMode): the plan gate fires once, then every mutating
   * action still asks individually.
   */
  runtimeMode?: 'full' | 'supervised' | 'plan';
  onStep: (steps: AgentStep[]) => void;
  onProgress?: (text: string) => void;
  onReasoning?: (value: string) => void;
  /** Current model turn's accumulated visible text; replaced when the next turn starts. */
  onContent?: (value: string) => void;
  /** Called with the full list each time it changes, so all of a turn's artifacts render. */
  onArtifact: (artifacts: AgentArtifact[]) => void;
  onSources?: (sources: SearchResult[]) => void;
  signal?: AbortSignal;
  maxIterations?: number;
  maxToolCalls?: number;
  maxTimeMs?: number;
  toolMode?: 'agent' | 'instant' | 'search_chat';
  /**
   * Instant fast path: collapse run activity to a single quiet status instead of
   * per-step updates. The caller still records steps; only the activity
   * surfacing is hushed. Port as part of the instant profile if Home moves to
   * the core engine (#12).
   */
  quietActivity?: boolean;
  /** chat = simple research agent; code = Flaxeo Agent; work = full sandbox; search = search tools */
  agentProfile?: 'chat' | 'code' | 'search' | 'work';
  searchMode?: 'search' | 'deep' | 'max';
  reasoningLevel?: ReasoningLevel | null;
  /** When true, skip token-budget trimming so uploaded/RAG document context stays intact. */
  preserveDocumentContext?: boolean;
};
