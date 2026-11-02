// ── Agente wire protocol (main ⇄ renderer) ─────────────────────────────
// The single definition of what crosses the Electron IPC boundary for
// Agente Coding: a flat CodeAgentEvent stream pushed over the
// `code_agent_event` channel, and the argument/result shapes of the
// `agente_*` invoke channels.
//
// Both processes import this file — main by relative path, the renderer
// through the `$shared/*` alias — so a change to the contract is a compile
// error on the side that has not caught up, instead of a silent drift
// between two hand-synced copies.

import type { RuntimeEvent } from './agente-protocol.gen';

/** How much autonomy the runtime has: plan-first, per-action approval, or free rein. */
export type AgenteRuntimeMode = 'full' | 'supervised' | 'plan';

/**
 * Canonical activity vocabulary shared by every agent surface.
 *
 * Previously each UI derived this from free text (`activityFromProgress` in
 * app-store-helpers, keyword maps in the Code store), which is how the same
 * state ended up "Thinking", "Thinking..." and "Planning" in three places.
 * Engines emit the key; each UI maps it to a localized label with its own
 * copy (renderer: `activityLabel` in utils/tool-ui.ts).
 */
export type AgentActivityKey =
  | 'planning'
  | 'searching'
  | 'reading'
  | 'creating_files'
  | 'writing'
  | 'stopped'
  | 'completed';

/**
 * Home run outcomes. Defined here so the Code wire and Home classify advisories
 * against one union instead of two hand-synced copies; renderer re-exports it
 * as `AgentStopReason` (types/chat.ts).
 */
export type HomeStopReason =
  | 'timeout'
  | 'loop'
  | 'tool_limit'
  | 'iteration_limit'
  | 'missing_artifacts'
  | 'error'
  | 'none';

/**
 * Reconcile the engine's stop reason with Home outcomes.
 *
 * `stop`/`toolUse` are healthy endings (`none` — Home's `outcome` carries
 * completed/partial/stopped separately); `length` is the iteration cap;
 * `error` stays an error. `aborted` maps to `none`, not `error`: a user
 * interrupt is not a failure, and Home's `stopped` outcome describes it.
 */
export function codeStopReasonToHomeStopReason(reason: CodeStopReason): HomeStopReason {
  switch (reason) {
    case 'length':
      return 'iteration_limit';
    case 'error':
      return 'error';
    default:
      return 'none';
  }
}

/**
 * Home accepts the engine's plan mode but executes it as supervised: the
 * plan gate fires once, then every mutating action still asks individually.
 */
export function normalizeHomeRuntimeMode(
  mode: 'full' | 'supervised' | 'plan' | undefined
): 'full' | 'supervised' | undefined {
  return mode === 'plan' ? 'supervised' : mode;
}

/** Answer to an `approval_request`. */
export type ApprovalDecision = 'allow' | 'deny';

export type CodeStopReason = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';

export interface CodeTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface CodeSpend {
  costUsd: number;
  estimated: boolean;
  unpriced: boolean;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CodeChild {
  id: string;
  kind: string;
  description: string;
  status: 'running' | 'done' | 'error';
  text: string;
  summary?: string;
  tools: Array<{ id: string; name: string; output: string; status: 'running' | 'done' | 'error' }>;
  spend: CodeSpend;
  /**
   * When the child's card appeared, stamped by the renderer — the wire carries
   * no start time for a child. It rides along into `codeChildren`, so a saved
   * turn keeps its duration, and nothing in main reads it.
   */
  startedAt?: number;
  /** When the child reached a terminal state; stamped by the renderer. */
  finishedAt?: number;
  /**
   * The model the runtime resolved for this child at spawn: the parent's, or
   * the `subagent_models` override for its type. Only the runtime knows it.
   */
  model?: string;
}

/** One file a turn produced, by reference — the bytes stay behind the wire. */
export interface CodeArtifactRef {
  kind: string;
  entryPath: string;
  title?: string;
  /** Opaque to the wire; each UI interprets what it understands. */
  manifest?: unknown;
  workProduct?: unknown;
}

/** One gathered source, by value — small enough to ride the event. */
export interface CodeSourceRef {
  title: string;
  url: string;
  snippet?: string;
  full_content?: string;
  provider?: string;
}

/** End-of-run rollup: outcome, advisories and full accounting in one place. */
export interface CodeRunSummary {
  outcome: 'completed' | 'partial' | 'stopped' | 'failed';
  homeStopReason: HomeStopReason;
  warning?: string;
  error?: string;
  publicFallback?: boolean;
  diagnosticsRedacted?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    contextWindow?: number;
    breakdown?: ContextBreakdown;
    /** Engine timings (prompt_ms, predicted_ms, …) when the provider reports them. */
    timings?: Record<string, number>;
  };
}

/** Estimated request components from Rust, in tokens. */
export interface ContextBreakdown {
  system: number;
  messages: number;
  toolResults?: number;
  tools?: number;
  overhead?: number;
  reserve?: number;
  window?: number;
}

export type CodeAgentEvent =
  | { type: 'agent_start'; chatId: string }
  | { type: 'agent_end'; chatId: string; stopReason: CodeStopReason; hitTurnLimit?: boolean }
  | { type: 'turn_start'; chatId: string; turnIndex: number }
  | { type: 'turn_end'; chatId: string; turnIndex: number }
  | { type: 'text_delta'; chatId: string; delta: string }
  | { type: 'thinking_delta'; chatId: string; delta: string }
  | { type: 'generation_stats'; chatId: string; tokensPerSecond: number }
  | { type: 'runtime_event'; chatId: string; event: RuntimeEvent; parentRunId?: string | null }
  | { type: 'tool_start'; chatId: string; toolCallId: string; toolName: string; args: unknown; label?: string; detail?: string }
  | { type: 'tool_update'; chatId: string; toolCallId: string; partialResult: unknown }
  | { type: 'tool_end'; chatId: string; toolCallId: string; result: unknown; isError: boolean; status?: 'done' | 'error'; fileChanges?: Array<{ path: string; kind: string }>; diffStats?: Array<{ path: string; kind: string; additions: number; deletions: number; patch?: string }> }
  | { type: 'llm_retry'; chatId: string; attempt: number; delayMs: number; discardPartial?: boolean }
  | { type: 'length_continue'; chatId: string; turnIndex: number }
  | { type: 'todo_update'; chatId: string; todos: CodeTodoItem[] }
  | { type: 'compaction_start'; chatId: string; reason: string; model?: string | null }
  | { type: 'compaction_end'; chatId: string; reason: string; success: boolean; tokensBefore?: number; tokensAfter?: number; summary?: string; smart?: boolean; requestedSmart?: boolean; modelTokens?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'approval_request'; chatId: string; requestId: string; toolName: string; args: unknown; diff?: string; kind?: 'action' | 'plan'; dangerous?: boolean; reason?: string }
  | { type: 'approval_resolved'; chatId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'checkpoint_captured'; chatId: string; turnIndex: number; fileCount: number }
  | {
      type: 'checkpoint_finalized';
      chatId: string;
      turnIndex: number;
      files: Array<{ path: string; additions: number; deletions: number; kind: string }>;
    }
  | {
      /** Real token accounting from the last model call; promptTokens is the context footprint. */
      type: 'usage';
      chatId: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      contextWindow: number;
      breakdown?: ContextBreakdown;
    }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'artifact_created'; chatId: string; artifact: CodeArtifactRef }
  | { type: 'artifact_list'; chatId: string; artifacts: CodeArtifactRef[] }
  | { type: 'sources'; chatId: string; sources: CodeSourceRef[] }
  | { type: 'sources_delta'; chatId: string; sources: CodeSourceRef[] }
  | { type: 'activity'; chatId: string; activity: AgentActivityKey }
  | { type: 'run_summary'; chatId: string; summary: CodeRunSummary }
  | { type: 'content_replace'; chatId: string; content: string }
  | { type: 'steer_acknowledged'; chatId: string; accepted: boolean; queuedCount?: number };

export interface LocalModelSelection {
  modelPath: string;
  baseUrl: string;
}

export interface AgenteStartSessionArgs {
  localSelection?: LocalModelSelection;
  chatId: string;
  projectRoot: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  runtimeMode: AgenteRuntimeMode;
  systemPromptOverride?: string;
  resumeSessionId?: string;
  checkpointsEnabled?: boolean;
}

export interface AgenteSessionInfo {
  sessionId: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
  title: string;
}

/** One turn's checkpoint, as returned by `agente_list_checkpoints`. */
export interface AgenteCheckpointSummary {
  turnIndex: number;
  createdAt: number;
  fileCount: number;
  additions: number;
  deletions: number;
  /** Paths the turn changed (relative to the project root). */
  files?: string[];
}

/** Alias kept for renderer code that imports CodeCheckpointSummary. */
export type CodeCheckpointSummary = AgenteCheckpointSummary;
