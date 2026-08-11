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

export interface PendingApproval {
  id: string;
  /** Which conversation is blocked, so the UI can find this without an id match. */
  chatId: string;
  command: string;
  cwd: string;
}

interface ApprovalRecord extends PendingApproval {
  resolve: (allow: boolean) => void;
}

class ApprovalsStore {
  items = $state<PendingApproval[]>([]);

  /** Resolvers are kept out of reactive state — they are not render data. */
  #resolvers = new Map<string, (allow: boolean) => void>();

  forChat(chatId: string): PendingApproval[] {
    if (!chatId) return [];
    return this.items.filter((item) => item.chatId === chatId);
  }

  /** Monotonic suffix guaranteeing distinct ids even within the same millisecond. */
  #seq = 0;

  /** Resolves once the user answers, or `false` if the run is torn down first. */
  request(input: PendingApproval): Promise<boolean> {
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
    return new Promise<boolean>((resolve) => {
      this.#resolvers.set(id, resolve);
      // Reassign rather than mutate so the rune notifies.
      this.items = [...this.items, { ...input, id }];
    });
  }

  resolve(id: string, allow: boolean): void {
    const resolver = this.#resolvers.get(id);
    if (!resolver) return;
    // Drop before resolving: a synchronous re-entrant request() from the
    // continuation must not observe this entry still pending.
    this.#resolvers.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    resolver(allow);
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
      resolver?.(false);
    }
  }
}

export const approvalsStore = new ApprovalsStore();
