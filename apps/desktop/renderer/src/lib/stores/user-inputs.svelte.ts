import type { InputResponseAction } from '$shared/agente-protocol';

export interface UserInputResolution {
  action: InputResponseAction;
  content?: Record<string, unknown>;
}

export interface PendingUserInput {
  id: string;
  requestId: string;
  chatId: string;
  message: string;
  toolCallId?: string;
  schema: Record<string, unknown>;
}

class UserInputsStore {
  items = $state<PendingUserInput[]>([]);

  #resolvers = new Map<string, (resolution: UserInputResolution) => void>();
  #seq = 0;

  forChat(chatId: string): PendingUserInput[] {
    if (!chatId) return [];
    return this.items.filter((item) => item.chatId === chatId);
  }

  request(input: Omit<PendingUserInput, 'requestId'>): Promise<UserInputResolution> {
    this.#seq += 1;
    const id = this.#resolvers.has(input.id) ? `${input.id}#${this.#seq}` : input.id;
    return new Promise<UserInputResolution>((resolve) => {
      this.#resolvers.set(id, resolve);
      this.items = [...this.items, { ...input, id, requestId: input.id }];
    });
  }

  resolve(id: string, resolution: UserInputResolution): void {
    const resolver = this.#resolvers.get(id);
    if (!resolver) return;
    this.#resolvers.delete(id);
    this.items = this.items.filter((item) => item.id !== id);
    resolver(resolution);
  }

  clearForChat(chatId: string): void {
    if (!chatId) return;
    const stale = this.items.filter((item) => item.chatId === chatId);
    if (!stale.length) return;
    this.items = this.items.filter((item) => item.chatId !== chatId);
    for (const item of stale) {
      const resolver = this.#resolvers.get(item.id);
      this.#resolvers.delete(item.id);
      resolver?.({ action: 'cancel' });
    }
  }
}

export const userInputsStore = new UserInputsStore();
