/**
 * Pending tool approvals.
 *
 * Keyed by chat, not by step id. The previous version matched a pending
 * approval against a step id, which meant the supervised-bash path could never
 * surface one: `agent.ts` mints a synthetic `bash-<ts>-<rand>` id while steps
 * get theirs from `uid('step')`, so the two never matched and the agent blocked
 * forever on a promise nothing could settle. Chat scoping removes the class of
 * bug rather than patching one instance of it.
 *
 * Despite the `.svelte.ts` extension the old module used no runes at all — its
 * reactivity was a hand-rolled listener list. This is a runes store so consumers
 * can just read `items`.
 */

import type { ApprovalOption } from '$shared/agente-protocol';

export interface ApprovalResolution {
  allow: boolean;
  decision: 'allow' | 'allow_all' | 'deny';
  optionId?: string;
}

export interface PendingApproval {
  /** Unique inside the store; equal to `requestId` unless two calls collided. */
  id: string;
  /**
   * The id the engine asked with. A transcript row knows its approval by this,
   * never by `id`, which the store may have suffixed.
   */
  requestId: string;
  /** Which conversation is blocked, so the UI can find this without an id match. */
  chatId: string;
  command: string;
  cwd: string;
  /** Destructive call (recursive delete, force push, pipes to the network…): the card says so. */
  dangerous?: boolean;
  /** Why a call asks beyond its kind, e.g. a shell command that reaches outside the project. */
  reason?: string;
  /** Native options offered by an external CLI driver, when available. */
  options?: ApprovalOption[];
}

/** Map a simple Enter/Esc boolean answer to a concrete resolution (choosing the primary native option when present). */
export function defaultResolution(allow: boolean, options?: readonly ApprovalOption[]): ApprovalResolution {
  if (allow) {
    const opt = options?.find((o) => o.kind === 'approve_once') ?? options?.find((o) => o.kind === 'approve_all');
    return {
      allow: true,
      decision: opt?.kind === 'approve_all' ? 'allow_all' : 'allow',
      ...(opt ? { optionId: opt.id } : {})
    };
  }
  const opt = options?.find((o) => o.kind === 'deny') ?? options?.find((o) => o.kind === 'cancel');
  return {
    allow: false,
    decision: 'deny',
    ...(opt ? { optionId: opt.id } : {})
  };
}

class ApprovalsStore {
  items = $state<PendingApproval[]>([]);

  /** Resolvers are kept out of reactive state — they are not render data. */
  #resolvers = new Map<string, (resolution: ApprovalResolution) => void>();

  forChat(chatId: string): PendingApproval[] {
    if (!chatId) return [];
    return this.items.filter((item) => item.chatId === chatId);
  }

  /**
   * The pending approval a transcript row stands for. A row keys on the id the
   * engine asked with, so a store-suffixed id still finds its own row — and a
   * row whose request has been answered finds nothing and stops asking.
   */
  forRequest(requestId: string): PendingApproval | undefined {
    return this.items.find((item) => item.requestId === requestId);
  }

  /** Monotonic suffix guaranteeing distinct ids even within the same millisecond. */
  #seq = 0;

  /** Resolves once the user answers, or `false` if the run is torn down first. */
  request(input: Omit<PendingApproval, 'requestId'>): Promise<boolean> {
    return this.requestDetailed(input).then((resolution) => resolution.allow);
  }

  /** Resolves with the explicit decision and native option id, when chosen. */
  requestDetailed(input: Omit<PendingApproval, 'requestId'>): Promise<ApprovalResolution> {
    /*
     * The id is made unique here rather than trusted from the caller.
     *
     * Callers mint ids like `bash-<Date.now()>-<4 random chars>`, so two parallel
     * `bash` calls in one batch can collide. On a collision the second `request`
     * overwrote the first's resolver in the map, orphaning that promise forever —
     * the agent waited on an approval nothing could ever settle — and pushed a
     * second `items` entry with the same id, which is also a duplicate key in the
     * UI's keyed `{#each}`.
     */
    this.#seq += 1;
    const id = this.#resolvers.has(input.id) ? `${input.id}#${this.#seq}` : input.id;
    return new Promise<ApprovalResolution>((resolve) => {
      this.#resolvers.set(id, resolve);
      // Reassign rather than mutate so the rune notifies.
      this.items = [...this.items, { ...input, id, requestId: input.id }];
    });
  }

  resolve(id: string, answer: boolean | ApprovalResolution): void {
    const resolver = this.#resolvers.get(id);
    if (!resolver) return;
    const pending = this.items.find((item) => item.id === id);
    const resolution = typeof answer === 'boolean' ? defaultResolution(answer, pending?.options) : answer;
    // Drop before resolving: a synchronous re-entrant request() from the
    // continuation must not observe this entry still pending.
    this.#resolvers.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    resolver(resolution);
  }

  /** Denies and drops everything still pending for a chat. */
  clearForChat(chatId: string): void {
    if (!chatId) return;
    const stale = this.items.filter((item) => item.chatId === chatId);
    if (!stale.length) return;
    this.items = this.items.filter((item) => item.chatId !== chatId);
    for (const item of stale) {
      const resolver = this.#resolvers.get(item.id);
      this.#resolvers.delete(item.id);
      resolver?.(defaultResolution(false, item.options));
    }
  }
}

export const approvalsStore = new ApprovalsStore();
