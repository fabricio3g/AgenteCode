import type { AgentStep, AgentArtifact, CodeAgentDiffStat, CodeAgentFileChange } from '$lib/types/chat';
import type { RunAgentTaskArgs, AgentTaskResult } from '$lib/services/agent-types';
import type { SearchResult } from '$lib/types/tauri';
import {
  startChateaAgentSession,
  promptChateaAgent,
  abortChateaAgent,
  closeChateaAgentSession,
  respondToApproval,
} from '$lib/services/chatea-agent-ipc';
import { subscribeToCodeAgentEvents } from '$lib/stores/chatea-agent-events.svelte';
import { addPendingApproval } from '$lib/stores/approvals.svelte';
import { codeAgentEventToStep } from '$lib/services/chatea-agent-bridge';

export interface ChateaAgentSessionConfig {
  chatId: string;
  projectRoot: string;
  provider: string;
  model: string;
  runtimeMode: 'full' | 'supervised';
  thinkingLevel?: string;
  systemPromptOverride?: string;
}

function approvalCommand(toolName: string, value: unknown): string {
  if (value && typeof value === 'object') {
    const args = value as Record<string, unknown>;
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
  }
  try {
    const json = JSON.stringify(value ?? {}, null, 2);
    return `${toolName} ${json}`.trim();
  } catch {
    return toolName;
  }
}

function approvalCwd(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const args = value as Record<string, unknown>;
    if (typeof args.cwd === 'string') return args.cwd;
    if (typeof args.projectRoot === 'string') return args.projectRoot;
  }
  return fallback || 'workspace';
}

export async function runChateaAgentSession(
  config: ChateaAgentSessionConfig,
  args: RunAgentTaskArgs,
): Promise<AgentTaskResult> {
  const steps: AgentStep[] = [];
  const stepMap = new Map<string, AgentStep>();
  const diffStats: CodeAgentDiffStat[] = [];
  const fileChanges: CodeAgentFileChange[] = [];
  let content = '';
  let reasoning = '';
  let artifact: AgentArtifact | null = null;
  const sources: SearchResult[] = [];
  const pendingApprovalIds = new Set<string>();
  let error: string | undefined;
  let resolved = false;

  const pushStep = (step: AgentStep) => {
    const existing = steps.findIndex((s) => s.id === step.id);
    if (existing >= 0) {
      steps[existing] = step;
    } else {
      steps.push(step);
    }
    stepMap.set(step.id, step);
    args.onStep([...steps]);
  };

  const { sessionId } = await startChateaAgentSession({
    chatId: config.chatId,
    projectRoot: config.projectRoot,
    provider: config.provider,
    model: config.model,
    runtimeMode: config.runtimeMode,
    thinkingLevel: config.thinkingLevel,
    systemPromptOverride: config.systemPromptOverride,
  });

  const unsub = subscribeToCodeAgentEvents(config.chatId, (event) => {
    if (resolved) return;

    switch (event.type) {
      case 'text_delta': {
        content += event.delta;
        args.onProgress?.(content);
        break;
      }
      case 'thinking_delta': {
        reasoning += event.delta;
        args.onReasoning?.(reasoning);
        break;
      }
      case 'tool_start': {
        const step = codeAgentEventToStep(event);
        if (step) pushStep(step);
        break;
      }
      case 'tool_end': {
        const step = codeAgentEventToStep(event);
        if (!step) break;
        const existing = steps.find((s) => s.id === step.id);
        if (existing) {
          existing.status = step.status;
          const outputStr = event.result != null ? String(event.result) : '';
          if (outputStr) {
            existing.output = outputStr.slice(0, 6000);
          }
        }
        args.onStep([...steps]);
        break;
      }
      case 'tool_update': {
        const existing = steps.find((s) => s.id === event.toolCallId);
        if (existing && event.partialResult != null) {
          existing.output = String(event.partialResult).slice(0, 6000);
          args.onStep([...steps]);
        }
        break;
      }
      case 'turn_start': {
        const step = codeAgentEventToStep(event);
        if (step) pushStep(step);
        break;
      }
      case 'turn_end': {
        const step = codeAgentEventToStep(event);
        if (step) {
          const existing = steps.find((s) => s.id === step.id);
          if (existing) {
            existing.status = 'done';
          } else {
            pushStep(step);
          }
        }
        break;
      }
      case 'approval_request': {
        const step: AgentStep = {
          id: event.requestId,
          type: 'approval',
          label: `Approval: ${event.toolName}`,
          status: 'awaiting_approval',
          detail: event.diff,
        };
        pushStep(step);
        if (!pendingApprovalIds.has(event.requestId)) {
          pendingApprovalIds.add(event.requestId);
          void (async () => {
            const allow = await addPendingApproval(event.requestId, approvalCommand(event.toolName, event.args), approvalCwd(event.args, config.projectRoot));
            await respondToApproval(config.chatId, event.requestId, allow ? 'allow' : 'deny').catch(() => {});
            const approvalStep = steps.find((s) => s.id === event.requestId);
            if (approvalStep) {
              approvalStep.status = allow ? 'done' : 'error';
              approvalStep.detail = allow ? 'Approved' : 'Denied';
              args.onStep([...steps]);
            }
          })();
        }
        break;
      }
      case 'approval_resolved': {
        const approvalStep = steps.find((s) => s.id === event.requestId);
        if (approvalStep) {
          approvalStep.status = event.decision === 'allow' ? 'done' : 'error';
          approvalStep.detail = event.decision === 'allow' ? 'Approved' : 'Denied';
          args.onStep([...steps]);
        }
        break;
      }
      case 'compaction_start':
      case 'compaction_end': {
        const step = codeAgentEventToStep(event);
        if (step) pushStep(step);
        break;
      }
      case 'checkpoint_finalized': {
        for (const f of event.files) {
          diffStats.push({
            path: f.path,
            kind: f.kind as 'created' | 'modified' | 'deleted',
            additions: f.additions,
            deletions: f.deletions,
          });
          fileChanges.push({
            path: f.path,
            kind: f.kind as 'created' | 'modified' | 'deleted',
          });
          const step = steps.find((s) => s.type === 'writing' || s.type === 'coding');
          if (step) {
            step.diffStats = [...diffStats];
            step.fileChanges = [...fileChanges];
          }
        }
        args.onStep([...steps]);
        break;
      }
      case 'error': {
        error = event.message;
        break;
      }
      case 'agent_end': {
        resolved = true;
        break;
      }
    }
  });

  const handleAbort = () => {
    abortChateaAgent(config.chatId);
  };
  args.signal?.addEventListener('abort', handleAbort, { once: true });

  // Send the user prompt
  const rawPrompt = args.rawPrompt || '';
  await promptChateaAgent(config.chatId, rawPrompt);

  return new Promise<AgentTaskResult>((resolve) => {
    const checkResolved = setInterval(() => {
      if (resolved) {
        clearInterval(checkResolved);
        unsub();
        args.signal?.removeEventListener('abort', handleAbort);
        closeChateaAgentSession(config.chatId).catch(() => {});

        resolve({
          content: content || 'Agent completed without producing output.',
          reasoning,
          steps,
          artifact,
          sources,
          outcome: error ? 'failed' : 'completed',
          stopReason: error ? 'error' : 'none',
          error,
        });
      }
    }, 100);
  });
}
