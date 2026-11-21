import type { AgentArtifact, AppConfig, ChatMessage, MessageVersion, ReasoningLevel } from '$lib/types/chat';
import type { RoleplayTurn } from '$lib/features/roleplay/roleplay-turn';
import type { CompletionResult, RequestMessage } from '$lib/services/chat/types';
import type { RoleplaySampling } from '$lib/services/roleplay-prompts';
import type { RunAgentTaskArgs } from '$lib/services/agent-types';
import type { ActiveGenerationRun, GenerationBackendMode, GenerationComposerMode } from '$lib/stores/app-store-types';
import { runAgentTask } from '$lib/services/agent';
import { runDesignTask } from '$lib/services/agent-design-runtime';
import { streamAssistantReply } from '$lib/services/chat-api';
import { applyHomeAgentResult, homeAgentCallbacks, settleAgentSteps, type HomeAgentPlan } from '$lib/features/home/home-turn';
import {
  appendStreamingContent,
  appendStreamingReasoning,
  finalizeAssistantMetadata,
  isAbortLikeError,
  markAgentStopped,
  markAgentWriting,
  startReasoningTimer,
  updateStreamingVersion
} from '$lib/stores/app-store-helpers';
import { toastStore } from '$lib/stores/toast.svelte';
import { toErrorMessage } from '$lib/utils/errors';

export interface ChatTurnAgentExecution {
  kind: 'agent';
  isDesign: boolean;
  plan: HomeAgentPlan;
  requestedSearchProvider: string;
  agentDebugLogs?: boolean;
  /** Throw AbortError immediately if aborted after runAgentTask returns (send path). */
  abortAfterAgent?: boolean;
  buildArgs: (ctx: {
    signal: AbortSignal;
    sync: (force?: boolean) => void;
    onReasoningStart: () => void;
  }) => Omit<RunAgentTaskArgs, 'onStep' | 'onProgress' | 'onReasoning' | 'onContent' | 'onArtifact' | 'onSources' | 'onLiveEvent'>;
}

export interface ChatTurnStreamExecution {
  kind: 'stream';
  config: AppConfig;
  messages: RequestMessage[];
  apiKey?: string;
  reasoningLevel?: ReasoningLevel | null;
  sampling?: RoleplaySampling;
  stop?: string[];
  extraParams?: Record<string, number>;
}

export interface ExecuteChatTurnArgs {
  chatId: string;
  message: ChatMessage;
  /** When regenerating, mirrors updates into this appended version slot. */
  targetVersion?: MessageVersion;
  backendMode: GenerationBackendMode;
  runMode: GenerationComposerMode;
  modelLabel: string;
  turn: RoleplayTurn;
  /** Show a toast on non-abort error (send path). */
  toastOnError?: boolean;
  /** When aborted, fallback to 'Stopped by user.' if empty (send path). */
  stopFallbackText?: string;
  /** Mark the last running agent step as errored on non-abort failure (send path). */
  markLastStepOnError?: boolean;
  /** Throttled sync interval in ms (send path uses 50ms; regenerate syncs immediately). */
  syncIntervalMs?: number;
  /** Prepare outbound messages / RAG / prompts inside the run lifecycle `try`. */
  prepare: (ctx: {
    controller: AbortController;
    sync: (force?: boolean) => void;
  }) => Promise<ChatTurnAgentExecution | ChatTurnStreamExecution>;
  /** Called on normal completion after metadata/version/steps settle, before final sync+persist. */
  onSuccess?: (ctx: {
    controller: AbortController;
    sync: (force?: boolean) => void;
  }) => Promise<void> | void;
  /** Called inside catch before final sync+persist. */
  onError?: (ctx: { aborted: boolean; errorMessage: string }) => void;
  /** Called inside finally after `endGenerationRun`. */
  onFinally?: (ctx: { controller: AbortController }) => void;
}

export interface ChatTurnHost {
  beginGenerationRun: (chatId: string, run: ActiveGenerationRun) => void;
  endGenerationRun: (chatId: string, controller: AbortController) => void;
  touchRun: (chatId: string) => void;
  syncMessage: (chatId: string, message: ChatMessage) => void;
  focusArtifact: (chatId: string, messageId: string, artifact: AgentArtifact | null | undefined) => void;
  findMessage: (chatId: string, messageId: string) => ChatMessage | undefined;
  setError: (error: string | null) => void;
  persist: () => void;
}

/**
 * Unified turn execution engine shared by `sendCurrentMessage` and
 * `regenerateMessage`: owns run lifecycle, throttled sync, agent vs stream
 * dispatch, version snapshotting/mirroring, metadata finalization, and
 * abort/error settlement.
 */
export async function executeChatTurn(host: ChatTurnHost, args: ExecuteChatTurnArgs): Promise<void> {
  const { chatId, message, targetVersion, backendMode, runMode, modelLabel, turn } = args;
  const syncIntervalMs = args.syncIntervalMs ?? 0;

  let lastSyncTime = 0;
  let trailingSync: ReturnType<typeof setTimeout> | undefined;
  const cancelTrailingSync = () => {
    if (trailingSync === undefined) return;
    clearTimeout(trailingSync);
    trailingSync = undefined;
  };

  const mirrorTargetVersion = () => {
    if (!targetVersion) return;
    targetVersion.content = message.content;
    targetVersion.reasoning = message.reasoning;
    const { currentActivity, activityLabel: label, codeTimeline } = message.metadata || {};
    if (currentActivity) {
      targetVersion.metadata = { ...(targetVersion.metadata || {}), currentActivity, activityLabel: label, codeTimeline };
    }
  };

  const sync = (force = false) => {
    if (syncIntervalMs > 0) {
      const now = Date.now();
      if (!force && now - lastSyncTime < syncIntervalMs) {
        if (trailingSync === undefined) {
          trailingSync = setTimeout(() => {
            trailingSync = undefined;
            sync(true);
          }, Math.max(1, syncIntervalMs - (now - lastSyncTime)));
        }
        return;
      }
      cancelTrailingSync();
      lastSyncTime = now;
    }
    mirrorTargetVersion();
    host.syncMessage(chatId, message);
  };

  const snapshotVersion = () => {
    if (targetVersion) {
      targetVersion.content = message.content;
      targetVersion.reasoning = message.reasoning;
      targetVersion.metadata = message.metadata;
    } else {
      message.versions = [{
        content: message.content,
        createdAt: message.createdAt,
        reasoning: message.reasoning,
        metadata: message.metadata
      }];
    }
  };

  const controller = new AbortController();
  const startTime = Date.now();
  const reasoningTimer = startReasoningTimer();
  let exactUsage: CompletionResult['usage'] = null;

  try {
    host.beginGenerationRun(chatId, {
      controller,
      messageId: message.id,
      backendMode,
      mode: runMode,
      startedAt: Date.now()
    });

    const execution = await args.prepare({ controller, sync });

    if (execution.kind === 'agent') {
      const taskArgs = execution.buildArgs({
        signal: controller.signal,
        sync,
        onReasoningStart: () => reasoningTimer.markStarted()
      });
      const agentResult = await (execution.isDesign ? runDesignTask : runAgentTask)({
        ...taskArgs,
        ...homeAgentCallbacks({
          message,
          quiet: execution.plan.instant,
          sync,
          persist: () => host.persist(),
          onReasoningStart: () => reasoningTimer.markStarted(),
          onArtifacts: (latest) => host.focusArtifact(chatId, message.id, latest),
          touch: () => host.touchRun(chatId)
        })
      });
      exactUsage = agentResult.usage || exactUsage;
      if (execution.abortAfterAgent && controller.signal.aborted) throw new Error('AbortError');
      markAgentWriting(message);
      sync(true);
      host.persist();
      applyHomeAgentResult(message, agentResult, {
        modelName: modelLabel,
        backendMode,
        searchMode: execution.plan.searchMode,
        requestedProvider: execution.requestedSearchProvider
      });
      if (targetVersion) {
        targetVersion.content = message.content;
        targetVersion.reasoning = message.reasoning;
        targetVersion.metadata = message.metadata;
      }
      if (execution.agentDebugLogs && (agentResult.warning || agentResult.error)) {
        console.info('[agent]', agentResult.warning || agentResult.error);
      }
      sync(true);
      host.persist();
      host.focusArtifact(chatId, message.id, agentResult.artifact);
    } else {
      await streamAssistantReply({
        config: execution.config,
        messages: execution.messages,
        signal: controller.signal,
        apiKey: execution.apiKey,
        reasoningLevel: execution.reasoningLevel,
        sampling: execution.sampling,
        stop: execution.stop,
        extraParams: execution.extraParams,
        onChunk: (value) => {
          reasoningTimer.markStopped();
          turn.record(value);
          if (targetVersion) {
            const nextContent = targetVersion.content + value;
            targetVersion.content = turn.sanitize ? turn.sanitize(nextContent) : nextContent;
            message.content = targetVersion.content;
            targetVersion.reasoning = message.reasoning;
          } else {
            appendStreamingContent(
              message,
              value,
              message.reasoning || '',
              message.metadata,
              turn.sanitize
            );
            if (message.agentSteps?.length) {
              message.agentSteps = message.agentSteps.map((step, index, all) => (
                index === all.length - 1 ? { ...step, status: 'running', detail: 'Streaming response' } : step
              ));
            }
          }
          sync();
        },
        onReasoning: (value) => {
          reasoningTimer.markStarted();
          if (targetVersion) {
            targetVersion.reasoning = appendStreamingReasoning(targetVersion.reasoning || '', value);
            message.reasoning = targetVersion.reasoning;
          } else {
            message.reasoning = appendStreamingReasoning(message.reasoning || '', value);
            updateStreamingVersion(message, message.content, message.reasoning, message.metadata);
          }
          sync();
        },
        onUsage: (usage) => {
          exactUsage = usage || exactUsage;
        }
      });
    }

    const timing = (Date.now() - startTime) / 1000;
    const baseMetadata = targetVersion ? targetVersion.metadata : message.metadata;
    message.metadata = finalizeAssistantMetadata({
      existing: baseMetadata,
      modelName: modelLabel,
      backendMode,
      usage: exactUsage,
      elapsedSeconds: timing,
      totalElapsedSeconds: timing,
      reasoningElapsedSeconds: reasoningTimer.elapsedSeconds()
    });
    if (targetVersion) {
      message.content = targetVersion.content;
    }
    message.done = true;
    turn.finalize(message);
    if ((message.status as ChatMessage['status']) !== 'error') {
      message.status = 'idle';
    }
    message.model = modelLabel;
    snapshotVersion();
    if (message.agentSteps?.length) {
      message.agentSteps = settleAgentSteps(message.agentSteps, message.metadata);
    }

    await args.onSuccess?.({ controller, sync });
    sync(true);
    host.persist();
  } catch (error) {
    const errorMsg = toErrorMessage(error) || 'Request failed';
    const aborted = controller.signal.aborted || isAbortLikeError(errorMsg);
    if (args.toastOnError && !aborted) {
      toastStore.error(errorMsg.length > 80 ? errorMsg.slice(0, 80) + '…' : errorMsg);
    }
    const currentInChat = host.findMessage(chatId, message.id);
    if (aborted && currentInChat && !targetVersion) {
      if ((currentInChat.content || '').trim()) message.content = currentInChat.content;
      if (currentInChat.agentSteps?.length) message.agentSteps = currentInChat.agentSteps;
    }
    const timing = (Date.now() - startTime) / 1000;
    const baseContent = targetVersion ? targetVersion.content : message.content;
    const resolvedContent = aborted
      ? ((baseContent || '').trim() ? baseContent : (args.stopFallbackText ?? ''))
      : (baseContent || errorMsg);
    message.content = resolvedContent;
    if (targetVersion) {
      message.reasoning = targetVersion.reasoning || '';
    }
    message.done = true;
    message.status = aborted ? 'idle' : 'error';
    message.metadata = finalizeAssistantMetadata({
      existing: targetVersion ? targetVersion.metadata : message.metadata,
      modelName: modelLabel,
      backendMode,
      elapsedSeconds: timing,
      totalElapsedSeconds: timing,
      reasoningElapsedSeconds: reasoningTimer.elapsedSeconds(),
      overrides: aborted ? {} : { error: true, errorMessage: errorMsg }
    });
    message.model = modelLabel;
    snapshotVersion();
    if (message.agentSteps?.length) {
      if (aborted) {
        markAgentStopped(message);
      } else if (args.markLastStepOnError) {
        message.agentSteps = message.agentSteps.map((step, index, all) => (
          index === all.length - 1 ? { ...step, status: 'error', detail: message.content } : step
        ));
      }
    }
    host.setError(aborted ? null : (targetVersion ? errorMsg : message.content));
    if (!targetVersion && turn.sanitize && (!aborted || message.content !== args.stopFallbackText)) {
      message.content = turn.sanitize(message.content);
    }
    args.onError?.({ aborted, errorMessage: errorMsg });
    sync(true);
    host.persist();
  } finally {
    cancelTrailingSync();
    host.endGenerationRun(chatId, controller);
    args.onFinally?.({ controller });
  }
}
