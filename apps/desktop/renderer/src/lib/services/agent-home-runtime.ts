/** Home's tools and product policy around Rust's turn engine. No renderer model calls. */
import type { AgentTaskResult, RunAgentTaskArgs } from './agent-types';
import type { Attachment, ClientToolCall, Message, RuntimeEvent, SessionSnapshot, TurnOutcome, Usage } from '$shared/agente-protocol.gen';
import type { HomeRuntimeEvent, HomeRuntimeMeta } from '$shared/home-runtime';
import { invoke, listen } from './bridge';
import { loadAppConfig } from '$lib/utils/storage';
import { resolveAgentRunPlan } from './agent-run-plan';
import { createAgentRun, emitSteps, injectLiveEvidence } from './agent-run-context';
import { createHomeTools } from './agent-home-tools';
import { createHomeHooks, createPolicyState, startThinkStep } from './agent-home-policy';
import { runResearchBootstrap } from './agent-research-bootstrap';
import { hasEnoughResearchEvidence } from './research-pipeline';
import { humanizeAgentError } from '$lib/utils/errors';
import { stripToolCallArtifacts } from './agent-parsing';
import { uid } from './agent-tool-dispatch';

const MUTATING = /^(?:write_|edit_|delete_|create_|domain_write$|preview_project$|browser_(?:open|click|fill|press|back|scroll)|design_(?:write|edit|snapshot)$)/;
function emptyMessage(role: Message['role'], content: string): Message { return { role, content }; }
export function canContinueHomeHistory(meta: HomeRuntimeMeta | undefined, ids: string[]): boolean {
  return !!meta && meta.historyIds.length === ids.length - 1 && meta.historyIds.every((id, index) => id === ids[index]);
}
const MAX_REQUEST_IMAGES = 20;

async function wireMessages(args: RunAgentTaskArgs): Promise<Message[]> {
  const nonSystemMessages = args.messages.filter((message) => message.role !== 'system');
  let imagesAllowed = MAX_REQUEST_IMAGES;
  const allowedKeys = new Set<string>();
  for (let m = nonSystemMessages.length - 1; m >= 0; m--) {
    const msg = nonSystemMessages[m];
    if (msg.attachments) {
      for (let a = msg.attachments.length - 1; a >= 0; a--) {
        const att = msg.attachments[a];
        if (att.kind === 'image' && att.base64) {
          if (imagesAllowed > 0) {
            allowedKeys.add(`${m}:${a}`);
            imagesAllowed--;
          }
        }
      }
    }
  }

  return Promise.all(nonSystemMessages.map(async (message, mIndex) => {
    let text = typeof message.content === 'string' ? message.content : (message.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
    const attachments: Attachment[] = [];
    const rawAttachments = message.attachments || [];
    for (let aIndex = 0; aIndex < rawAttachments.length; aIndex++) {
      const attachment = rawAttachments[aIndex];
      if (attachment.kind === 'image' && attachment.base64) {
        if (allowedKeys.has(`${mIndex}:${aIndex}`)) {
          const data = attachment.base64.replace(/^data:[^;]+;base64,/, '');
          const imported = await invoke<{ attachment: Attachment }>('agente_media_import', { name: attachment.name || 'image.png', data });
          attachments.push(imported.attachment);
        } else {
          text += `\n[Image: ${attachment.name || 'image'} (omitted from earlier history to stay under provider limit)]`;
        }
      }
    }
    return { role: message.role, content: text, ...(attachments.length ? { attachments } : {}) };
  }));
}
type Settled = { outcome: TurnOutcome; snapshot: SessionSnapshot };
type HomeTools = ReturnType<typeof createHomeTools>['tools'];
/**
 * What another space swaps into Home's runtime: its own tools and system
 * prompt. The events, budgets, cancellation and retry stay shared; Home's
 * research bootstrap and reply review do not run.
 */
export interface SpaceRuntime {
  systemPrompt: string;
  tools(run: ReturnType<typeof createAgentRun>): HomeTools;
  /** Runs once after the turn settles, whatever its outcome. */
  finished?(status: TurnOutcome['status']): Promise<void>;
}
type Hooks = ReturnType<typeof createHomeHooks>;
type ToolReply = { content: string; isError?: boolean; images?: Array<{ data: string; mimeType: string }> };

/** Tool images go to the runtime as stored attachments, never inline bytes. */
/** The core reads an image's type from the file name, so the extension must match the bytes (a design reference can be a GIF or WebP). */
const IMAGE_EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
async function importImages(images: ToolReply['images']): Promise<Attachment[]> {
  return Promise.all((images || []).map(async (image) => (await invoke<{ attachment: Attachment }>('agente_media_import', { name: `screenshot.${IMAGE_EXTENSION[image.mimeType] ?? 'png'}`, data: image.data })).attachment));
}

/**
 * One Home turn's renderer side: it streams what the runtime says into the
 * message, answers the runtime's calls to Home's tools, and keeps the
 * context meter's reading current. Rust runs the loop; this only reacts.
 */
class HomeTurn {
  text = '';
  reasoning = '';
  status: TurnOutcome['status'] = 'completed';
  error: string | undefined;
  meta: HomeRuntimeMeta | undefined;
  activeRunId = '';
  hooks: Hooks | undefined;
  state: ReturnType<typeof createPolicyState> | undefined;
  /** Replaces Home's system prompt for a space that brings its own. */
  systemPrompt: string | undefined;
  #waiting: { resolve: (settled: Settled) => void; reject: (error: Error) => void } | undefined;
  readonly #calls = new Map<string, AbortController>();

  constructor(
    readonly args: RunAgentTaskArgs,
    readonly run: ReturnType<typeof createAgentRun>,
    readonly tools: HomeTools,
    readonly controller: AbortController
  ) {}

  updateMeta(): void {
    if (this.meta) this.args.onRuntime?.({ ...this.meta, files: { ...this.run.ctx.files } });
  }

  #usage(usage: Usage): void {
    const run = this.run;
    run.usage = { prompt_tokens: usage.context_tokens || usage.prompt_tokens + usage.cache_read_tokens + usage.cache_creation_tokens, completion_tokens: usage.completion_tokens };
    this.args.onUsage?.(run.usage);
    if (this.meta && run.usage.prompt_tokens) {
      Object.assign(this.meta, { contextTokens: run.usage.prompt_tokens, estimated: false });
      this.updateMeta();
    }
  }

  #compacted(event: Extract<RuntimeEvent, { type: 'context_compacted' }>): void {
    const step = [...this.run.steps].reverse().find((item) => item.label === 'Compacting context' && item.status === 'running');
    if (step) Object.assign(step, { status: 'done', label: 'Context compacted', detail: `${(event.tokens_before || 0).toLocaleString()} → ${(event.tokens_after || 0).toLocaleString()} · ${event.smart ? 'summarized' : 'trimmed'}` });
    if (this.meta) {
      Object.assign(this.meta, { revision: event.revision, contextTokens: event.tokens_after, estimated: true });
      this.updateMeta();
    }
    emitSteps(this.run);
    this.args.onProgress?.('Continuing');
  }

  /** What each runtime event means for the message; events not listed change nothing here. */
  readonly #handlers: { [K in RuntimeEvent['type']]?: (event: Extract<RuntimeEvent, { type: K }>) => void } = {
    user_messages_injected: (event) => {
      this.args.onMessagesInjected?.(event.messages);
      this.text = ''; this.reasoning = '';
    },
    assistant_delta: (event) => { this.text += event.text; this.args.onContent?.(this.text); },
    assistant_message: (event) => { this.text = event.text; this.args.onContent?.(this.text); },
    reasoning_delta: (event) => { this.reasoning += event.text; this.args.onReasoning?.(this.reasoning); },
    thinking: () => {
      const run = this.run;
      if (run.currentStep?.status === 'running') run.currentStep.status = 'done';
      this.text = '';
      run.turn += 1;
      if (this.state) startThinkStep(run, this.state, run.turn);
    },
    retry: (event) => this.args.onProgress?.(`Retrying (${event.attempt}/${event.max_attempts})`),
    usage: (event) => this.#usage(event.usage),
    call_usage: (event) => this.#usage(event.usage),
    compaction_started: () => {
      this.run.steps.push({ id: uid('compact'), type: 'thinking', label: 'Compacting context', status: 'running' });
      this.args.onProgress?.('Compacting context');
      emitSteps(this.run);
    },
    context_compacted: (event) => this.#compacted(event),
    turn_failed: (event) => { this.error = humanizeAgentError(event.message); this.status = 'failed'; },
    turn_cancelled: (event) => { this.status = 'cancelled'; this.text ||= event.partial_text; }
  };

  receive(event: RuntimeEvent): void {
    (this.#handlers[event.type] as ((event: RuntimeEvent) => void) | undefined)?.(event);
  }

  /** Main's event for this turn (events from an earlier retry attempt are ignored). */
  onRuntimeEvent(event: HomeRuntimeEvent): void {
    if (event.runId !== this.activeRunId) return;
    if (event.type === 'event') this.receive(event.envelope.event);
    else if (event.type === 'outcome') this.#waiting?.resolve(event);
    else if (event.type === 'error') this.#waiting?.reject(new Error(event.message));
    else if (event.type === 'cancel') { this.#calls.get(event.call.request_id)?.abort(); this.#calls.delete(event.call.request_id); }
    else void this.#answer(event.call);
  }

  async #execute(call: ClientToolCall, signal: AbortSignal): Promise<ToolReply> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new Error('This tool is disabled for this Home turn.');
    const args = call.arguments as Record<string, unknown>;
    const blocked = await this.hooks?.beforeToolCall?.(call.call_id, call.name, args);
    if (blocked?.block) return { content: blocked.block, isError: true };
    // Core schedules mutating calls sequentially; read calls share this turn's context.
    return tool.execute(call.call_id, args, { signal });
  }

  /** Run the tool the runtime asked for and send its result back — unless the turn or call was cancelled. */
  async #answer(call: ClientToolCall): Promise<void> {
    const callController = new AbortController();
    this.#calls.set(call.request_id, callController);
    const runId = this.activeRunId;
    const live = () => !this.controller.signal.aborted && !callController.signal.aborted;
    const reply = (content: string, isError: boolean, attachments: Attachment[] = []) => invoke('home_runtime_result', { runId, result: { session_id: call.session_id, turn_id: call.turn_id, request_id: call.request_id, content, is_error: isError, attachments } });
    try {
      const result = await this.#execute(call, callController.signal);
      if (live()) await reply(result.content, !!result.isError, await importImages(result.images));
    } catch (error) {
      if (live()) await reply(String(error), true).catch(() => {});
    } finally {
      this.#calls.delete(call.request_id);
    }
  }

  /** A promise for the current attempt's outcome, armed before the turn starts. */
  settled(): Promise<Settled> {
    const done = new Promise<Settled>((resolve, reject) => { this.#waiting = { resolve, reject }; });
    // Attach rejection immediately; startup errors otherwise leave an unhandled promise.
    void done.catch(() => {});
    return done;
  }

  cancel = (): void => {
    for (const call of this.#calls.values()) call.abort();
    if (this.activeRunId) void invoke('home_runtime_cancel', { runId: this.activeRunId }).catch(() => {});
  };
}

function toolManifest(tools: HomeTools) {
  return [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, mutating: MUTATING.test(tool.name), sequential: tool.executionMode === 'sequential' }));
}

/** Bootstrap evidence is current, and retained retrieval tools can recover uploaded documents. */
function homeSystemPrompt(run: ReturnType<typeof createAgentRun>): string {
  const evidence = run.messages.slice(run.history.length + 1)
    .filter((message) => message.role !== 'system' && message.role !== 'assistant')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
  return [run.plan.prompts.native, ...evidence].filter(Boolean).join('\n\n');
}

function homeResult(turn: HomeTurn): AgentTaskResult {
  const { run } = turn;
  const content = stripToolCallArtifacts(run.finalContent || turn.text);
  const error = turn.status === 'failed' ? turn.error || 'The Home turn failed.' : run.errorReason;
  if (error) run.steps.push({ id: uid('error'), type: 'error', label: 'Could not complete request', status: 'error', detail: error });
  emitSteps(run);
  const stopped = turn.status === 'cancelled';
  return {
    content, reasoning: turn.reasoning, steps: run.steps, artifact: run.artifacts.at(-1) || null, artifacts: run.artifacts, sources: run.sources,
    outcome: error ? 'failed' : stopped ? 'stopped' : 'completed',
    stopReason: error ? 'error' : stopped ? (turn.controller.signal.aborted ? 'none' : 'timeout') : run.stopReason,
    ...(error ? { error } : {}), ...(run.usage ? { usage: run.usage } : {})
  };
}

type Attempt = { sessionId?: string; forkIndex?: number; conversation?: Message[]; prompt?: Message; systemPrompt: string; wrapUp?: boolean };

/** The core's reply when a turn runs out of iterations while the model still wants tools. Its text is the only budget signal the runtime sends. */
export const ITERATION_LIMIT_NOTICE = /^Reached the iteration limit \(\d+\) for this turn\./;
/** The one tool-less step that replaces the notice; its reply says where the turn stands. */
const WRAP_UP_PROMPT = "You've used this turn's step budget. Do not call tools. In a short reply, say what you finished, what is left, and what the user should ask next to continue.";
/** The runtime cancels a turn at max_time_ms, so a wrap-up keeps this floor even when the run's clock is spent. */
const WRAP_UP_MIN_TIME_MS = 2 * 60 * 1000;

/** Turn budgets: what is left of the run's iterations, tool calls and time. A wrap-up is one step with no tools. */
function remainingPolicy(turn: HomeTurn, wrapUp = false) {
  const { run, args } = turn;
  const plan = run.plan;
  const leftMs = plan.maxTimeMs - (Date.now() - run.startTime);
  if (wrapUp) return { max_iterations: 1, max_tool_calls: 0, max_time_ms: Math.max(WRAP_UP_MIN_TIME_MS, leftMs) };
  return {
    max_iterations: args.noTools ? 1 : Math.max(1, plan.maxIterations - run.turn),
    max_tool_calls: Math.max(0, plan.maxToolCalls - run.totalToolCalls),
    max_time_ms: Math.max(1, leftMs)
  };
}

/** Start one runtime turn and point the context meter at its session. */
async function startAttempt(turn: HomeTurn, attempt: Attempt): Promise<{ sessionId: string; conversationIndex?: number }> {
  const { run, args } = turn;
  const plan = run.plan;
  const provider = plan.localMode ? 'local' : plan.providerName;
  const { wrapUp, ...start } = attempt;
  turn.activeRunId = crypto.randomUUID();
  const started = await invoke<{ sessionId: string; turnId: string; conversationIndex?: number; contextWindow: number }>('home_runtime_start', {
    runId: turn.activeRunId, ...start, provider, model: plan.activeModel, thinkingLevel: args.reasoningLevel || 'auto',
    localSelection: plan.localMode ? { modelPath: run.config.llm?.local?.selected_model_path || '', baseUrl: run.config.llm?.local?.base_url || '' } : undefined,
    policy: remainingPolicy(turn, wrapUp), tools: wrapUp ? [] : toolManifest(turn.tools)
  });
  if (!started) throw new Error('The agent runtime did not start the turn.');
  turn.meta = { sessionId: started.sessionId, revision: turn.meta?.revision || args.homeRuntime?.revision || 0, provider, model: plan.activeModel, contextWindow: started.contextWindow, historyIds: args.historyIds || [], files: run.ctx.files };
  if (run.usage?.prompt_tokens) Object.assign(turn.meta, { contextTokens: run.usage.prompt_tokens, estimated: false });
  turn.updateMeta();
  return started;
}

function recordOutcome(turn: HomeTurn, finished: Settled): void {
  if (turn.meta) turn.meta.revision = finished.snapshot.revision;
  turn.status = finished.outcome.status;
  turn.error ||= finished.outcome.error || undefined;
  turn.updateMeta();
}

/** Home's review of a finished reply: the follow-up prompt for another attempt, or nothing. */
async function retryPrompt(turn: HomeTurn, attempt: number): Promise<Message | undefined> {
  const { run, args } = turn;
  const plan = run.plan;
  // A plain Instant answer is the reply as streamed: nothing to review or retry.
  if (turn.status !== 'completed' || args.noTools) return undefined;
  if (!run.currentStep && turn.state) startThinkStep(run, turn.state, Math.max(1, run.turn));
  const review = await turn.hooks?.reviewFinalReply?.({ role: 'assistant', content: turn.text, ts: Date.now() }, run.turn);
  const outOfBudget = attempt === 2 || run.turn >= plan.maxIterations || Date.now() - run.startTime >= plan.maxTimeMs;
  if (!review?.retry?.length || outOfBudget) return undefined;
  return emptyMessage('user', review.retry.map((message) => message.content).join('\n\n'));
}

/**
 * The attempt ended on the core's iteration budget: a completed turn whose reply
 * is the notice, not an answer. Records that as the run's stop reason. A run the
 * user stopped is not wrapped up.
 */
function endedOnBudget(turn: HomeTurn): boolean {
  if (turn.status !== 'completed' || turn.controller.signal.aborted || !ITERATION_LIMIT_NOTICE.test(turn.text)) return false;
  turn.run.stopReason = 'iteration_limit';
  return true;
}

/**
 * Start runtime turns until the reply settles. Home's review may ask for another
 * attempt (at most three). An attempt that ran out of iterations gets one
 * tool-less wrap-up on the same session instead, and the wrap-up is the last word.
 */
async function driveTurns(turn: HomeTurn, onIndex: (index: number | undefined) => void): Promise<void> {
  const { args, run, controller } = turn;
  const history = await wireMessages(args);
  injectLiveEvidence(run);
  const resume = canContinueHomeHistory(args.homeRuntime, args.historyIds || []) || args.forkIndex !== undefined;
  const sessionId = resume ? args.homeRuntime?.sessionId : undefined;
  let next: Attempt | undefined = { sessionId, forkIndex: args.forkIndex, conversation: sessionId ? undefined : history, prompt: history.at(-1), systemPrompt: turn.systemPrompt ?? homeSystemPrompt(run) };
  let budgetNotice = '';
  for (let attempt = 0; next; attempt += 1) {
    const done = turn.settled();
    const started = await startAttempt(turn, next);
    onIndex(started.conversationIndex);
    if (controller.signal.aborted) turn.cancel();
    recordOutcome(turn, await done);
    let following: Attempt | undefined;
    if (next.wrapUp) {
      // A wrap-up that left no reply (refused, cut short or empty) leaves the core's notice as the reply.
      if (!turn.text.trim()) {
        turn.text = budgetNotice;
        args.onContent?.(budgetNotice);
        if (turn.status === 'failed') { turn.status = 'completed'; turn.error = undefined; }
      }
    } else if (endedOnBudget(turn)) {
      budgetNotice = turn.text;
      following = { sessionId: started.sessionId, prompt: emptyMessage('user', WRAP_UP_PROMPT), systemPrompt: next.systemPrompt, wrapUp: true };
    } else {
      const prompt = await retryPrompt(turn, attempt);
      if (prompt) following = { sessionId: started.sessionId, prompt, systemPrompt: next.systemPrompt };
    }
    next = following;
    if (next) { turn.text = ''; args.onContent?.(''); }
  }
}

export async function runHomeRuntime(args: RunAgentTaskArgs, space?: SpaceRuntime): Promise<AgentTaskResult> {
  const config = args.config ?? await loadAppConfig();
  const plan = resolveAgentRunPlan(args, config, { isElectron: true });
  const controller = new AbortController();
  const abort = () => controller.abort();
  args.signal?.addEventListener('abort', abort, { once: true });
  if (args.signal?.aborted) abort();
  const run = createAgentRun({ ...args, signal: controller.signal }, config, plan);
  run.ctx.files = { ...(args.homeRuntime?.files || {}) };
  const turn = new HomeTurn(args, run, args.noTools ? new Map() : space ? space.tools(run) : createHomeTools(run, true).tools, controller);
  turn.systemPrompt = space?.systemPrompt;
  let bootstrapped = false;
  try { bootstrapped = args.noTools || space ? false : await runResearchBootstrap(run); } catch (error) { args.signal?.removeEventListener('abort', abort); throw error; }
  if (!space) {
    turn.state = createPolicyState(run, bootstrapped, plan.isResearchChat && bootstrapped && hasEnoughResearchEvidence(plan.researchMode, run.sources));
    turn.hooks = createHomeHooks(run, turn.state);
  }
  const unlisten = await listen<HomeRuntimeEvent>('home_runtime_event', (event) => turn.onRuntimeEvent(event));
  controller.signal.addEventListener('abort', turn.cancel, { once: true });
  let conversationIndex: number | undefined;
  try {
    controller.signal.throwIfAborted();
    await driveTurns(turn, (index) => { conversationIndex ??= index; });
  } catch (error) {
    if (controller.signal.aborted) turn.status = 'cancelled';
    else { turn.status = 'failed'; turn.error = humanizeAgentError(error); }
  } finally {
    turn.cancel(); unlisten(); args.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', turn.cancel);
    for (const step of run.steps) if (step.status === 'running') step.status = turn.status === 'failed' ? 'error' : 'done';
  }
  await space?.finished?.(turn.status).catch(() => {});
  if (turn.meta && conversationIndex !== undefined) args.onConversationIndex?.(conversationIndex, turn.meta.sessionId, turn.meta.revision);
  return homeResult(turn);
}
