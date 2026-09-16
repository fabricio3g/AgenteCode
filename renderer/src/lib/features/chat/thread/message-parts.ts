import type { AgentArtifact, ChatMessage, MessageVersion, SearchMeta } from '$lib/types/chat';
import type { DocumentSurfaceItem } from '$lib/features/chat/document-surface';
import { artifactsForMessage } from '$lib/stores/app-store-artifacts';

/**
 * The ordered contents of an assistant message.
 *
 * This used to be thirteen `{#if}` blocks stacked in a template, with the rules
 * about which ones may appear together written down in comments rather than
 * code. Two of those rules were already being violated. Expressing the stack as
 * data makes the ordering and the mutual exclusions testable — see
 * `message-parts.spec.ts` — and means a part can only claim a fact once.
 */
export type MessagePart =
  | { kind: 'deep-research' }
  | { kind: 'reasoning'; reasoning: string; timing: number; totalElapsedSeconds?: number }
  | { kind: 'tool-status' }
  | { kind: 'approval' }
  | { kind: 'error'; title: string; detail: string }
  | { kind: 'warning'; detail: string }
  | { kind: 'pending'; status?: string }
  | { kind: 'content'; content: string }
  | { kind: 'document'; title: string; docs: DocumentSurfaceItem[] }
  | { kind: 'slides' }
  | { kind: 'files-created' }
  /**
   * One part per artifact the turn produced. A turn can create several — a chart
   * *and* a diagram — and each gets its own block. `index` disambiguates the
   * `{#each}` key, since `kind` alone is no longer unique.
   */
  | { kind: 'artifact'; artifact: AgentArtifact; index: number };

export type MessagePartKind = MessagePart['kind'];

export interface BuildMessagePartsInput {
  message: ChatMessage;
  displayContent: string;
  displayReasoning: string;
  displayMetadata: MessageVersion['metadata'] | null;
  /** User setting: reasoning traces are hidden entirely when false. */
  enableThinking: boolean;
  /** A live deep-research task owns the whole surface while it runs. */
  hasActiveDeepResearch: boolean;
  /** The artifact already renders as a document, so don't render a second one. */
  hasDocumentArtifact: boolean;
  /** The run is blocked on a tool approval the user has not answered yet. */
  hasPendingApproval: boolean;
}

function cleanReportTitle(value: string): string {
  return String(value || '')
    .replace(/^#+\s*/, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function resolveReasoningTiming(metadata: MessageVersion['metadata'] | null | undefined) {
  return typeof metadata?.reasoningTimingSeconds === 'number'
    ? metadata.reasoningTimingSeconds
    : undefined;
}

export function resolveTotalElapsed(
  message: ChatMessage,
  metadata: MessageVersion['metadata'] | null | undefined
): number | undefined {
  if (!metadata) return undefined;
  if (typeof metadata.totalElapsedSeconds === 'number') return metadata.totalElapsedSeconds;
  const isWallClockRun =
    message.mode === 'agent' || metadata.outcome === 'partial' || metadata.outcome === 'stopped';
  if (isWallClockRun && typeof metadata.timing === 'number') return metadata.timing;
  return undefined;
}

/**
 * Total elapsed time, but only when it says something the reasoning timer
 * doesn't. A non-agent turn has no wall-clock story worth a second number, and
 * an agent turn whose total matches its reasoning time would print the same
 * duration twice.
 */
function resolveDisplayTotalElapsed(
  message: ChatMessage,
  metadata: MessageVersion['metadata'] | null | undefined
): number | undefined {
  const isAgentRun =
    message.mode === 'agent' ||
    !!message.agentSteps?.length ||
    metadata?.outcome === 'partial' ||
    metadata?.outcome === 'stopped';
  if (!isAgentRun) return undefined;

  const total = resolveTotalElapsed(message, metadata);
  if (typeof total !== 'number' || total <= 0) return undefined;

  const reasoning = resolveReasoningTiming(metadata);
  if (typeof reasoning === 'number' && reasoning > 0 && Math.abs(total - reasoning) < 0.25) {
    return undefined;
  }
  return total;
}

export function buildMessageParts(input: BuildMessagePartsInput): MessagePart[] {
  const {
    message,
    displayContent,
    displayReasoning,
    displayMetadata,
    enableThinking,
    hasActiveDeepResearch,
    hasDocumentArtifact,
    hasPendingApproval
  } = input;

  const parts: MessagePart[] = [];
  const isStreaming = message.status === 'streaming';
  const hasContent = !!displayContent;
  // Ask fast path renders a single quiet status, never the planning chrome:
  // no reasoning trace, no tool-status line. Steps are still recorded on the
  // message (and approvals still render below) — only the surfacing is hushed.
  const isQuietAsk = message.mode === 'ask';
  const hasReasoning = enableThinking && !!displayReasoning && !isQuietAsk;
  const hasSteps = !!message.agentSteps?.length;

  if (hasActiveDeepResearch) parts.push({ kind: 'deep-research' });

  const hasAgentActivity = hasSteps || message.mode === 'agent';
  if (hasReasoning && !hasAgentActivity) {
    parts.push({
      kind: 'reasoning',
      reasoning: displayReasoning,
      timing: resolveReasoningTiming(displayMetadata) || 0,
      totalElapsedSeconds: resolveDisplayTotalElapsed(message, displayMetadata)
    });
  }

  // One status line for the whole tool run. The step-by-step list lives in the
  // activity drawer; duplicating it inline was the single biggest source of
  // vertical noise in an agent turn.
  const awaitingFirstAgentOutput =
    message.mode === 'agent' && isStreaming && !hasContent && !hasActiveDeepResearch;
  if (!isQuietAsk && (hasSteps || awaitingFirstAgentOutput || hasReasoning && hasAgentActivity)) parts.push({ kind: 'tool-status' });

  // Directly under the status line: the run is stopped until this is answered,
  // so it outranks everything else in the turn. Pushing it here also means the
  // `parts.length === 0` guard below suppresses the typing dots, which would
  // otherwise imply the agent was still working.
  if (hasPendingApproval) parts.push({ kind: 'approval' });

  if (message.status === 'error' && displayMetadata?.error) {
    parts.push({
      kind: 'error',
      title: 'Generation failed',
      detail: displayMetadata.errorMessage || displayContent || ''
    });
  } else if (
    displayMetadata?.warning &&
    !hasContent &&
    (displayMetadata.outcome === 'partial' || displayMetadata.outcome === 'stopped')
  ) {
    parts.push({ kind: 'warning', detail: displayMetadata.warning });
  }

  // Typing dots only when there is genuinely nothing else on screen. The old
  // condition tested for agent *steps* rather than for the status line, so an
  // agent turn that had started but not yet recorded a step showed the dots
  // underneath its own "Planning…" line.
  if (isStreaming && !hasContent && parts.length === 0) {
    parts.push(isQuietAsk && displayMetadata?.activityLabel ? { kind: 'pending', status: displayMetadata.activityLabel } : { kind: 'pending' });
  }

  if (hasContent) parts.push({ kind: 'content', content: displayContent });

  const isReportSurface =
    hasContent &&
    displayMetadata?.documentSurface?.kind === 'report' &&
    message.status !== 'error' &&
    !hasDocumentArtifact;

  if (isReportSurface) {
    const title = cleanReportTitle(
      displayMetadata?.documentSurface?.title ||
        displayContent.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ||
        'Document'
    );
    parts.push({
      kind: 'document',
      title,
      docs: [
        {
          id: `${message.id}:report`,
          name: `${slugify(title) || 'document'}.md`,
          title,
          content: displayContent,
          kind: 'report',
          status: displayMetadata?.workProduct?.status || 'ready'
        }
      ]
    });
  }

  if (message.slides?.length) parts.push({ kind: 'slides' });
  if (message.filesCreated?.length) parts.push({ kind: 'files-created' });
  for (const [index, artifact] of artifactsForMessage(message).entries()) {
    parts.push({ kind: 'artifact', artifact, index });
  }

  return parts;
}

/** True when the message has nothing at all to show and should be skipped. */
export function isAssistantMessageEmpty(input: {
  message: ChatMessage;
  displayContent: string;
  displayReasoning: string;
  displayMetadata: MessageVersion['metadata'] | null;
  hasActiveDeepResearch: boolean;
}): boolean {
  const { message, displayContent, displayReasoning, displayMetadata, hasActiveDeepResearch } = input;
  if (message.role !== 'assistant') return false;
  if (hasActiveDeepResearch) return false;
  if (message.status === 'streaming') return false;
  if (displayContent.trim()) return false;
  if (displayReasoning.trim()) return false;
  if (message.sources?.length) return false;
  if (message.slides?.length) return false;
  if (message.filesCreated?.length) return false;
  if (artifactsForMessage(message).length) return false;
  if (message.agentSteps?.some((step) => step.diffStats?.length)) return false;
  if (displayMetadata?.error || displayMetadata?.warning) return false;
  return true;
}

/** Search status is only worth a line when it adds something the sources don't. */
export function hasSearchStatus(
  meta: SearchMeta | null,
  hasSources: boolean
): boolean {
  if (!meta) return false;
  return (
    !!meta.searchError ||
    !!meta.searchFallbackReason ||
    !!meta.providerWarnings?.length ||
    !!meta.researchSummary ||
    (!hasSources && !!meta.searchRequested)
  );
}
