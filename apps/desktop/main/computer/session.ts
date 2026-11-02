import type { ComputerAction, ComputerObservation, ComputerState, ComputerSpace } from '../../shared/computer.ts';
import { EMPTY_COMPUTER_STATE, COMPUTER_TASK_BUDGET } from '../../shared/computer.ts';

/** The action was rejected before native input; the agent can correct it. */
export class ComputerActionRejected extends Error {}

export interface ComputerOwner {
  sessionId: string;
  turnId: string;
  chatId: string;
  space: ComputerSpace;
  webContentsId: number;
  stop(): void;
  resume(): void;
}
export interface ComputerPlatform {
  ready(): Promise<void>;
  confirm(owner: ComputerOwner, task: string): Promise<boolean>;
  arm(lease: number): Promise<void>;
  revoke(): void;
  observe(): Promise<ComputerObservation>;
  act(action: ComputerAction, observation: ComputerObservation, lease: number): Promise<{ x: number; y: number } | undefined>;
  present(state: ComputerState): Promise<void>;
  dismiss(): void;
}

/** No renderer or model argument can create a grant or resume a paused lease. */
export class ComputerSession {
  state: ComputerState = { ...EMPTY_COMPUTER_STATE };
  owner?: ComputerOwner;
  private generation = 0;
  private observation?: ComputerObservation;
  private pendingAction = false;
  private resumeAllowed = false;
  private settledTurn = false;
  private pausedTurn?: string;
  private revision = 0;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(readonly platform: ComputerPlatform, readonly changed: (state: ComputerState) => void) {}

  private publish() {
    this.changed({ ...this.state });
    void this.platform.present(this.state).catch(() => this.takeover('overlay_unavailable'));
  }
  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.takeover('inactive'), COMPUTER_TASK_BUDGET.idleMs);
    this.idle.unref?.();
  }
  private owns(owner: ComputerOwner) {
    return this.owner?.sessionId === owner.sessionId && this.owner?.webContentsId === owner.webContentsId;
  }
  private assertTurn(owner: ComputerOwner) {
    if (!this.owns(owner) || this.owner?.turnId !== owner.turnId) throw new Error('Computer control belongs to another chat or turn.');
  }
  /** Bind the next turn only after a trusted user explicitly chose Resume. */
  attach(owner: ComputerOwner) {
    if (this.owns(owner) && this.resumeAllowed && this.state.phase === 'preparing' && owner.turnId !== this.pausedTurn) {
      this.owner = owner;
      this.settledTurn = false;
    }
  }
  async request(owner: ComputerOwner, task: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.owns(owner) && this.owner?.turnId === owner.turnId && this.state.phase === 'active') return;
    if (this.owns(owner) && this.resumeAllowed && this.state.phase === 'preparing') {
      this.assertTurn(owner);
      if (owner.turnId === this.pausedTurn) throw new Error('The cancelled turn cannot resume computer control.');
      await this.activate(owner, signal);
      return;
    }
    if (['requesting', 'preparing', 'active', 'paused'].includes(this.state.phase)) throw new Error('Computer control is already owned. Open its chat, take over or end that session.');
    await this.platform.ready();
    signal.throwIfAborted();
    // Readiness is async: another request may have acquired the desktop.
    if (['requesting', 'preparing', 'active', 'paused'].includes(this.state.phase)) throw new Error('Computer control is already owned.');
    this.owner = owner;
    this.settledTurn = false;
    this.resumeAllowed = false;
    const revision = ++this.revision;
    this.state = { phase: 'requesting', task, activity: 'Waiting for your permission', chatId: owner.chatId, space: owner.space, actions: 0, canResume: false };
    this.publish();
    const cancel = () => { if (this.revision === revision) this.end('cancelled'); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const allowed = await this.platform.confirm(owner, task);
      signal.throwIfAborted();
      if (this.revision !== revision) throw new Error('Computer request was cancelled.');
      if (!allowed) { this.end('denied'); throw new Error('The user declined computer control. Continue without it.'); }
      await this.activate(owner, signal);
    } finally { signal.removeEventListener('abort', cancel); }
  }
  private async activate(owner: ComputerOwner, signal: AbortSignal) {
    this.assertTurn(owner);
    this.resumeAllowed = false;
    const revision = this.revision;
    const lease = ++this.generation;
    this.state = { ...this.state, phase: 'preparing', activity: 'Preparing computer control', canResume: false };
    this.publish();
    try {
      await this.platform.arm(lease);
      signal.throwIfAborted();
      if (revision !== this.revision || this.state.phase !== 'preparing') throw new Error('Computer control was revoked.');
      this.state = { ...this.state, phase: 'active', startedAt: this.state.startedAt ?? Date.now(), activity: 'Looking at the desktop', reason: undefined };
      await this.platform.present(this.state);
      signal.throwIfAborted();
      if (revision !== this.revision || this.state.phase !== 'active') throw new Error('Computer control was revoked.');
      this.touch(); this.publish();
    } catch (error) { if (this.revision === revision) this.takeover('startup_failed'); throw error; }
  }
  private async active(owner: ComputerOwner, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.resumeAllowed && this.state.phase === 'preparing') {
      this.assertTurn(owner);
      if (owner.turnId === this.pausedTurn) throw new Error('The cancelled turn cannot resume computer control.');
      await this.activate(owner, signal);
    }
    this.assertTurn(owner);
    if (this.state.phase !== 'active') throw new Error('control_revoked: the user is in control. Wait for an explicit Resume.');
    this.touch();
  }
  private verify(owner: ComputerOwner, generation: number, signal: AbortSignal) {
    signal.throwIfAborted(); this.assertTurn(owner);
    if (this.state.phase !== 'active' || this.generation !== generation) throw new Error('control_revoked');
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pendingAction) throw new Error('Another desktop operation is in progress. Observe and act sequentially.');
    this.pendingAction = true;
    try { return await fn(); } finally { this.pendingAction = false; }
  }
  async observe(owner: ComputerOwner, signal: AbortSignal) {
    return this.serial(async () => {
      await this.active(owner, signal);
      const generation = this.generation;
      this.state.activity = 'Looking at the desktop'; this.publish();
      const observation = await this.platform.observe();
      this.verify(owner, generation, signal);
      this.observation = observation;
      return observation;
    });
  }
  async act(owner: ComputerOwner, observationId: string, action: ComputerAction, signal: AbortSignal) {
    return this.serial(async () => {
      await this.active(owner, signal);
      const observation = this.observation;
      if (!observation || observation.id !== observationId || Date.now() - observation.capturedAt > 30_000) throw new Error('Take a fresh computer_observe before acting.');
      this.observation = undefined; // An uncertain result is never replayable.
      const generation = this.generation;
      this.state.activity = { move: 'Moving the pointer', click: 'Clicking', drag: 'Dragging', scroll: 'Scrolling', key: 'Pressing keys', type: 'Typing' }[action.kind];
      this.publish();
      const cancel = () => this.takeover('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const pointer = await this.platform.act(action, observation, generation);
        this.verify(owner, generation, signal);
        this.state = { ...this.state, actions: this.state.actions + 1, ...(pointer ? { pointer } : {}) };
        this.publish();
        return { ok: true, action: action.kind, next: 'Observe the desktop to verify the result before the next action.' };
      } catch (error) {
        if (this.state.phase === 'active' && !(error instanceof ComputerActionRejected)) this.takeover('action_failed');
        throw error;
      }
      finally { signal.removeEventListener('abort', cancel); }
    });
  }
  takeover(reason = 'user') {
    if (!['active', 'preparing', 'requesting'].includes(this.state.phase)) return;
    ++this.revision; ++this.generation;
    this.resumeAllowed = false; this.observation = undefined; clearTimeout(this.idle);
    this.pausedTurn = this.owner?.turnId;
    this.platform.revoke();
    this.state = { ...this.state, phase: 'paused', activity: "You're in control", canResume: this.settledTurn, reason, pointer: undefined };
    this.publish(); this.owner?.stop();
  }
  /** Called only from trusted owner/control-bar IPC, never from a tool. */
  resume() {
    if (this.state.phase !== 'paused' || !this.settledTurn || !this.owner) throw new Error('Wait for the previous turn to stop before resuming.');
    this.resumeAllowed = true;
    this.state = { ...this.state, phase: 'preparing', activity: 'Resuming the task', canResume: false };
    this.publish(); this.touch(); this.owner.resume();
  }
  settled(sessionId: string, turnId: string) {
    if (this.owner?.sessionId !== sessionId || this.owner.turnId !== turnId) return;
    this.settledTurn = true;
    if (this.state.phase === 'paused') { this.state.canResume = true; this.publish(); }
    else this.end('turn_finished');
  }
  finish(owner: ComputerOwner) { this.assertTurn(owner); this.end('completed'); }
  end(reason = 'ended') {
    ++this.revision; ++this.generation; this.resumeAllowed = false;
    clearTimeout(this.idle); this.observation = undefined; this.platform.revoke();
    this.state = { ...this.state, phase: 'ended', activity: 'Computer use ended', reason, canResume: false, pointer: undefined };
    this.changed({ ...this.state }); this.platform.dismiss(); this.owner = undefined;
  }
  releaseOwner(webContentsId: number) { if (this.owner?.webContentsId === webContentsId) this.end('owner_closed'); }
}
