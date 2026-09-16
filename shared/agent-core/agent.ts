// ── Stateful Agent wrapper ─────────────────────────────────────────────
// Owns the transcript, the steer/follow-up queues, the abort controller and
// the subscriber list. The loop itself stays pure; everything mutable lives
// here (pi's Agent/agent-loop split).

import { runAgentLoop, type AgentLoopHooks } from './agent-loop.ts';
import type {
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentTool,
  AssistantMessage,
  StreamFn,
  UserMessage
} from './types.ts';

export interface AgentOptions {
  systemPrompt: string;
  tools: Map<string, AgentTool>;
  enabledTools: Set<string>;
  streamFn: StreamFn;
  maxTurns?: number;
  hooks?: AgentLoopHooks;
}

export class Agent {
  readonly options: AgentOptions;
  messages: AgentMessage[] = [];
  isStreaming = false;

  private listeners: AgentEventListener[] = [];
  private steerQueue: UserMessage[] = [];
  private followUpQueue: UserMessage[] = [];
  private abortController: AbortController | null = null;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      // Listener errors never take down the run — persistence and UI are
      // observers, not participants.
      try {
        void listener(event);
      } catch {
        // ignored
      }
    }
  }

  /**
   * Course-correct mid-run: injected after the current turn's tools finish,
   * before the next model call.
   */
  steer(text: string): void {
    this.steerQueue.push({ role: 'user', content: `[steer] ${text}`, ts: Date.now() });
  }

  /** Queued input that only runs when the agent would otherwise stop. */
  followUp(text: string): void {
    this.followUpQueue.push({ role: 'user', content: text, ts: Date.now() });
  }

  abort(): void {
    this.abortController?.abort();
  }

  /** True when a run is currently executing. */
  get busy(): boolean {
    return this.isStreaming;
  }

  async prompt(userMessage: UserMessage): Promise<void> {
    if (this.isStreaming) {
      // A second prompt while streaming becomes a follow-up — the UI's
      // composer can stay dumb about run state.
      this.followUpQueue.push(userMessage);
      return;
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.messages.push(userMessage);
    this.isStreaming = true;

    try {
      await runAgentLoop({
        messages: this.messages,
        config: { maxTurns: this.options.maxTurns ?? 40 },
        tools: this.options.tools,
        enabledTools: this.options.enabledTools,
        streamFn: this.options.streamFn,
        systemPrompt: this.options.systemPrompt,
        emit: (event) => this.emit(event),
        signal,
        hooks: this.options.hooks,
        drainSteered: () => this.steerQueue.splice(0),
        drainFollowUps: () => this.followUpQueue.splice(0)
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const failure: AssistantMessage = {
        role: 'assistant',
        content: '',
        stopReason: 'error',
        errorMessage: message,
        ts: Date.now()
      };
      this.messages.push(failure);
      this.emit({ type: 'message_end', message: failure });
      this.emit({ type: 'error', message });
      this.emit({ type: 'agent_end', stopReason: 'error' });
    } finally {
      this.isStreaming = false;
      this.abortController = null;
    }
  }
}
