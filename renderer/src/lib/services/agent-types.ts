import type { AgentArtifact, AgentOutcome, AgentStep, AgentStopReason, ReasoningLevel, WorkspaceFile } from '$lib/types/chat';
import type { CompletionResult, RequestMessage } from '$lib/services/chat-api';
import type { SearchResult } from '$lib/types/tauri';

export type ToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  success: boolean;
  output?: unknown;
  error?: string;
  note?: string;
  createdFiles?: string[];
  modifiedFiles?: string[];
  deletedFiles?: string[];
  nextTurnMods?: {
    instructions?: string;
    temperature?: number;
    injectMessages?: RequestMessage[];
    disableNativeTools?: boolean;
  };
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
  onArtifact: (artifact: AgentArtifact | null) => void;
  workProduct?: AgentArtifact['workProduct'];
};

export type AgentTaskResult = {
  content: string;
  reasoning: string;
  steps: AgentStep[];
  artifact: AgentArtifact | null;
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
  runtimeMode?: 'full' | 'supervised';
  onStep: (steps: AgentStep[]) => void;
  onProgress?: (text: string) => void;
  onReasoning?: (value: string) => void;
  onArtifact: (artifact: AgentArtifact | null) => void;
  onSources?: (sources: SearchResult[]) => void;
  signal?: AbortSignal;
  maxIterations?: number;
  maxToolCalls?: number;
  maxTimeMs?: number;
  toolMode?: 'agent' | 'search_chat';
  /** chat = simple research agent; code = Flaxeo Agent; work = full sandbox; search = search tools */
  agentProfile?: 'chat' | 'code' | 'search' | 'work';
  searchMode?: 'search' | 'deep' | 'max';
  reasoningLevel?: ReasoningLevel | null;
  /** When true, skip token-budget trimming so uploaded/RAG document context stays intact. */
  preserveDocumentContext?: boolean;
};
