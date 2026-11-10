import type { RuntimeEvent } from '$shared/agente-protocol.gen';
import { trackPreparing, type CodeRunState } from '$lib/features/code/code-run';
import type { AgentStep } from '$lib/types/chat';

export type HomeLiveState = Pick<CodeRunState, 'phase' | 'preparing' | 'retrying'>;

export function updateHomeLive(state: HomeLiveState, event: RuntimeEvent): void {
  switch (event.type) {
    case 'turn_started':
    case 'thinking':
      state.phase = 'requesting';
      break;
    case 'reasoning_delta':
      state.phase = 'thinking';
      break;
    case 'assistant_delta':
    case 'assistant_message':
      state.phase = 'writing';
      break;
    case 'compaction_started':
      state.phase = 'compacting';
      break;
    case 'context_compacted':
    case 'tool_result':
    case 'tool_proposed':
      state.phase = 'requesting';
      break;
    case 'generation_progress':
      state.preparing = trackPreparing(state.preparing, event.tool_name, event.output_bytes);
      state.retrying = null;
      return;
    case 'retry':
      state.retrying = { attempt: event.attempt, delayMs: event.delay_ms };
      return;
    default:
      return;
  }
  state.preparing = null;
  state.retrying = null;
}

export function homeWorkSteps(steps: AgentStep[] = []): AgentStep[] {
  return steps.filter(step => !step.preface && !(step.type === 'thinking' && !step.toolName && step.id.startsWith('turn-')));
}
