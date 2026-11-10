/**
 * The Home space's agent turn: how a run is planned (profile, tool list,
 * budget) and how its result lands on the assistant message.
 *
 * Send and regenerate both go through here, so a regenerated answer runs
 * with exactly the plan its original turn had — same research depth, same
 * Instant fast path — and fails, warns or completes with the same wording.
 */

import type { AgentStep, ChatMessage, CodeTimelineEntry, MessageVersion } from '$lib/types/chat';
import type { SearchResult } from '$lib/types/bridge';
import type { AgentTaskResult, RunAgentTaskArgs } from '$lib/services/agent-types';
import type { GenerationBackendMode } from '$lib/stores/app-store-types';
import { humanizeAgentError } from '$lib/utils/errors';
import { homeWorkSteps } from './home-live';
import {
  activityFromProgress,
  agentOutcome,
  agentStopReason,
  executionMetadata,
  finalizeAssistantMetadata,
  hasUsableAgentResult,
  setAgentActivity,
  reliableUsageMetadata
} from '$lib/stores/app-store-helpers';

type SearchMode = 'chat' | 'search' | 'deep' | 'max';
type Budget = Required<Pick<RunAgentTaskArgs, 'maxIterations' | 'maxToolCalls' | 'maxTimeMs'>>;

/** Instant fast path: tight enough that the loop cannot go on a journey. */
const INSTANT_BUDGET: Budget = { maxIterations: 4, maxToolCalls: 8, maxTimeMs: 90 * 1000 };
/** Plain Home agent turns. */
const CHAT_BUDGET: Budget = { maxIterations: 12, maxToolCalls: 24, maxTimeMs: 5 * 60 * 1000 };
/** Research depth budgets, keyed by search mode. */
const SEARCH_BUDGETS: Record<Exclude<SearchMode, 'chat'>, Budget> = {
  search: { maxIterations: 10, maxToolCalls: 24, maxTimeMs: 5 * 60 * 1000 },
  deep: { maxIterations: 28, maxToolCalls: 90, maxTimeMs: 14 * 60 * 1000 },
  max: { maxIterations: 48, maxToolCalls: 140, maxTimeMs: 22 * 60 * 1000 }
};

export interface HomeAgentPlan {
  instant: boolean;
  agentProfile: 'chat' | 'search';
  toolMode: NonNullable<RunAgentTaskArgs['toolMode']>;
  searchMode?: Exclude<SearchMode, 'chat'>;
  budget: Budget;
}

/**
 * The run shape for a Home turn. Research depth picks the search profile and
 * its budget; Instant keeps its own allowlist and budget whatever the depth.
 */
export function planHomeAgentRun(args: { composerMode: string | undefined; searchMode: SearchMode | undefined }): HomeAgentPlan {
  const instant = args.composerMode === 'instant';
  const searchMode = args.searchMode && args.searchMode !== 'chat' ? args.searchMode : undefined;
  return {
    instant,
    agentProfile: searchMode ? 'search' : 'chat',
    toolMode: instant ? 'instant' : searchMode ? 'search_chat' : 'agent',
    searchMode,
    budget: instant ? INSTANT_BUDGET : searchMode ? SEARCH_BUDGETS[searchMode] : CHAT_BUDGET
  };
}

/** The first activity a Home agent turn shows before the engine reports anything. */
export function initialHomeActivity(plan: { instant: boolean; searchMode?: string }, composerMode: string | undefined) {
  const searching = plan.instant || (!!plan.searchMode && composerMode !== 'agent');
  return {
    activity: searching ? 'searching' as const : 'planning' as const,
    detail: plan.instant
      ? 'Checking sources'
      : composerMode === 'agent'
        ? 'Preparing tools and context'
        : plan.searchMode
          ? 'Preparing search tools and context'
          : 'Checking if tools are needed'
  };
}

/** Sources not already on the message, in arrival order. */
function newSources(message: ChatMessage, incoming: SearchResult[]): SearchResult[] {
  const known = new Set((message.sources || []).map((source) => source.url));
  return incoming.filter((source) => !known.has(source.url));
}

/** Merge live sources into the message; true when anything was added. */
function mergeLiveSources(message: ChatMessage, incoming: SearchResult[]): boolean {
  const added = newSources(message, incoming);
  if (!added.length) return false;
  message.sources = [...(message.sources || []), ...added];
  if (!message.searchMode || message.searchMode === 'chat') message.searchMode = 'search';
  return true;
}

/**
 * Engine callbacks shared by send and regenerate. `sync` pushes the message
 * to the reactive store (`force` for structural changes), `persist` saves.
 */
export function homeAgentCallbacks(args: {
  message: ChatMessage;
  quiet: boolean;
  sync: (force?: boolean) => void;
  persist: () => void;
  onReasoningStart: () => void;
  onArtifacts: (latest: ChatMessage['artifact']) => void;
  /** Punches the run's clock. Without it a live run and a silent one look alike. */
  touch: () => void;
}): Pick<RunAgentTaskArgs, 'onContent' | 'onStep' | 'onProgress' | 'onReasoning' | 'onArtifact' | 'onSources' | 'onUsage' | 'onSpend'> {
  const { message, quiet, sync, persist, touch } = args;
  let timeline: CodeTimelineEntry[] = [];
  let previousReasoning = '';
  const knownSteps = new Set<string>();
  const recordWork = (entries: CodeTimelineEntry[]) => {
    timeline = entries;
    message.metadata = { ...message.metadata, codeTimeline: entries };
  };
  const showActivity = (label: string) => {
    const mapped = activityFromProgress(label);
    setAgentActivity(message, mapped.currentActivity, mapped.activityLabel);
  };
  return {
    onUsage: (usage) => {
      message.metadata = { ...message.metadata, ...reliableUsageMetadata(usage, 0, 'provider') };
      sync();
    },
    onSpend: (spend) => {
      message.metadata = { ...message.metadata, codeSpend: spend };
      sync();
    },
    onContent: (value) => {
      touch();
      message.content = value;
      sync();
    },
    onStep: (steps) => {
      touch();
      message.agentSteps = steps;
      const added = homeWorkSteps(steps).filter(step => !knownSteps.has(step.id));
      for (const step of added) knownSteps.add(step.id);
      if (added.length) recordWork([...timeline, ...added.map(step => ({ kind: 'step' as const, id: step.id }))]);
      const running = quiet ? undefined : steps.find((step) => step.status === 'running');
      if (running) showActivity(running.label);
      sync(true);
      persist();
    },
    onProgress: (text) => {
      touch();
      if (!quiet) showActivity(text);
      sync();
    },
    onReasoning: (value) => {
      touch();
      args.onReasoningStart();
      message.reasoning = value;
      const continued = value.startsWith(previousReasoning);
      const delta = continued ? value.slice(previousReasoning.length) : value;
      previousReasoning = value;
      const last = timeline.at(-1);
      if (delta && continued && last?.kind === 'thinking') {
        recordWork([...timeline.slice(0, -1), { kind: 'thinking', text: last.text + delta }]);
      } else if (delta) {
        recordWork([...timeline, { kind: 'thinking', text: delta }]);
      }
      sync();
    },
    onArtifact: (artifacts) => {
      touch();
      const latest = artifacts.length ? artifacts[artifacts.length - 1] : null;
      message.artifacts = artifacts;
      message.artifact = latest;
      sync(true);
      persist();
      args.onArtifacts(latest);
    },
    onSources: (liveSources) => {
      touch();
      if (!mergeLiveSources(message, liveSources)) return;
      sync(true);
      persist();
    }
  };
}

function workProductRef(result: AgentTaskResult) {
  const product = result.artifact?.workProduct;
  if (!product) return undefined;
  return {
    id: product.id,
    kind: product.kind,
    title: product.title,
    primaryFile: product.files[0]?.path,
    status: product.status
  };
}

/**
 * Land a finished run on the message: content, status and metadata by
 * outcome, then reasoning, steps, artifact, sources and search metadata.
 *
 * - failed with nothing usable → error message, friendly text;
 * - partial/stopped/warned → a normal answer carrying a warning;
 * - completed → a normal answer.
 */
export function applyHomeAgentResult(
  message: ChatMessage,
  result: AgentTaskResult,
  ctx: {
    modelName: string;
    backendMode: GenerationBackendMode;
    /** The turn's research depth; a failed research run still records its search. */
    searchMode?: string;
    requestedProvider: string;
  }
): void {
  const outcome = agentOutcome(result);
  const stopReason = agentStopReason(result);
  const usable = hasUsableAgentResult(result);
  const shared = {
    ...(result.spend ? { codeSpend: result.spend } : {}),
    outcome,
    stopReason,
    workProduct: workProductRef(result),
    publicFallback: !!result.publicFallback,
    diagnosticsRedacted: !!result.diagnosticsRedacted
  };
  const finalize = (overrides: Partial<NonNullable<MessageVersion['metadata']>>) => finalizeAssistantMetadata({
    existing: message.metadata,
    modelName: ctx.modelName,
    backendMode: ctx.backendMode,
    noUsageTimingScope: 'agent_wall',
    overrides: { ...shared, ...overrides }
  });

  if (outcome === 'failed' && result.error && !usable) {
    const friendly = humanizeAgentError(result.error);
    message.content = result.content?.trim() ? result.content : friendly;
    message.status = 'error';
    message.metadata = finalize({
      error: true,
      errorMessage: friendly,
      currentActivity: 'stopped',
      activityLabel: 'Agent failed'
    });
  } else if (result.warning || outcome === 'partial' || outcome === 'stopped') {
    message.content = result.content;
    message.status = 'idle';
    message.metadata = finalize({
      warning: result.warning
        || (result.error ? humanizeAgentError(result.error) : undefined)
        || 'Stopped before finishing. You can continue the conversation.',
      currentActivity: 'stopped',
      activityLabel: 'Stopped'
    });
  } else {
    message.content = result.content;
    message.metadata = {
      ...(message.metadata || {}),
      ...executionMetadata(ctx.backendMode),
      ...shared,
      currentActivity: 'completed',
      activityLabel: 'Agent finished'
    };
  }
  message.done = true;

  message.reasoning = result.reasoning;
  // Diff steps recorded live (file edits) survive when the final list drops them.
  const liveDiffSteps = (message.agentSteps || []).filter(
    (step) => step.diffStats?.length && !result.steps.some((final) => final.id === step.id)
  );
  message.agentSteps = [...result.steps, ...liveDiffSteps];
  message.artifact = result.artifact;

  if (result.sources?.length) {
    mergeLiveSources(message, result.sources);
    if (!message.searchMode || message.searchMode === 'chat') message.searchMode = 'search';
    message.searchMeta = {
      ...(message.searchMeta || { searchRequested: true, searchSucceeded: true, contextAvailable: true, sourceCount: 0 }),
      searchRequested: true,
      searchSucceeded: true,
      contextAvailable: true,
      sourceCount: message.sources?.length || 0,
      stopReason
    };
  } else if (ctx.searchMode && ctx.searchMode !== 'chat') {
    message.searchMeta = {
      ...(message.searchMeta || {}),
      searchRequested: true,
      searchSucceeded: !result.error,
      contextAvailable: false,
      sourceCount: message.sources?.length || 0,
      requestedProvider: ctx.requestedProvider,
      searchError: result.error || result.warning || '',
      stopReason
    };
  }
}

/**
 * Close out the step list once the turn has settled: the last step reflects
 * the outcome, anything still running is marked done.
 */
export function settleAgentSteps(steps: AgentStep[], metadata: MessageVersion['metadata']): AgentStep[] {
  const failed = metadata?.error;
  const warning = metadata?.warning;
  return steps.map((step, index, all) => {
    if (step.toolName && step.status !== 'running' && step.status !== 'pending') return step;
    if (index === all.length - 1) {
      if (failed) return { ...step, status: 'error', detail: step.detail || 'Agent encountered an error' };
      if (warning) return { ...step, status: 'done', detail: warning };
      return { ...step, status: 'done', detail: metadata?.outcome === 'completed' ? 'Response ready' : step.detail };
    }
    return { ...step, status: step.status === 'running' ? 'done' : step.status };
  });
}
