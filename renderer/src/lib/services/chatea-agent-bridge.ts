import type { CodeAgentEvent } from '$lib/services/chatea-agent-ipc';
import type { AgentStep } from '$lib/types/chat';

export function codeAgentEventToStep(event: CodeAgentEvent): AgentStep | null {
  switch (event.type) {
    case 'tool_start':
      return {
        id: event.toolCallId,
        type: 'tool',
        label: event.toolName,
        status: 'running',
        detail: typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {}).slice(0, 200)
      };
    case 'tool_end':
      return {
        id: event.toolCallId,
        type: 'tool',
        label: 'tool',
        status: event.isError ? 'error' : 'done'
      };
    case 'turn_start':
      return {
        id: `turn-${event.turnIndex}`,
        type: 'planning',
        label: 'Turn starting',
        status: 'running'
      };
    case 'turn_end':
      return {
        id: `turn-${event.turnIndex}`,
        type: 'done',
        label: 'Turn complete',
        status: 'done'
      };
    case 'approval_request':
      return {
        id: event.requestId,
        type: 'approval',
        label: `Approval: ${event.toolName}`,
        status: 'awaiting_approval',
        detail: event.diff
      };
    case 'compaction_start':
      return {
        id: `compaction-${event.chatId}`,
        type: 'planning',
        label: 'Compacting context',
        status: 'running'
      };
    case 'compaction_end':
      return {
        id: `compaction-${event.chatId}`,
        type: 'done',
        label: 'Context compacted',
        status: 'done'
      };
    default:
      return null;
  }
}
