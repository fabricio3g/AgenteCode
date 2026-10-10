import type { DesignSystemDetail, DesignSystemRequest, DesignSystemSummary } from '$shared/design';
import { invoke } from '$lib/services/bridge';

/**
 * The library of design systems, and the one the open design uses. Main owns
 * the files and the link; this holds the list for the pickers and refetches
 * after every change. Failures throw so the caller can say what went wrong.
 */
class DesignSystemsStore {
  list = $state.raw<DesignSystemSummary[]>([]);
  /** The system the design `linkedFor` uses; null for none. */
  linked = $state.raw<DesignSystemSummary | null>(null);
  linkedFor = $state<string | null>(null);

  private call<T>(request: DesignSystemRequest): Promise<T> {
    return invoke<T>('design_systems', request as unknown as Record<string, unknown>);
  }

  /** Reload the library, and which system `chatId` uses. */
  async refresh(chatId: string | null): Promise<void> {
    const [list, linked] = await Promise.all([
      this.call<DesignSystemSummary[]>({ action: 'list' }).catch(() => [] as DesignSystemSummary[]),
      chatId ? this.call<DesignSystemSummary | null>({ action: 'current', chatId }).catch(() => null) : Promise.resolve(null)
    ]);
    this.list = list;
    this.linked = linked;
    this.linkedFor = chatId;
  }

  detail(id: string): Promise<DesignSystemDetail> {
    return this.call<DesignSystemDetail>({ action: 'get', id });
  }

  async save(chatId: string, name: string, description: string): Promise<DesignSystemSummary> {
    const saved = await this.call<DesignSystemSummary>({ action: 'create', chatId, name, description });
    await this.refresh(this.linkedFor);
    return saved;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.call<DesignSystemSummary>({ action: 'rename', id, name });
    await this.refresh(this.linkedFor);
  }

  async remove(id: string): Promise<void> {
    await this.call<{ deleted: true }>({ action: 'delete', id });
    await this.refresh(this.linkedFor);
  }

  /** Copy the system into the design and link them. The design's files change, so the canvas follows on its own. */
  async apply(chatId: string, id: string): Promise<void> {
    await this.call<unknown>({ action: 'apply', chatId, id });
    await this.refresh(chatId);
  }

  async unlink(chatId: string): Promise<void> {
    await this.call<{ ok: true }>({ action: 'unlink', chatId });
    await this.refresh(chatId);
  }

  /** Build a system from a project folder the user picks; null when they cancel. */
  async importFolder(): Promise<DesignSystemSummary | null> {
    const imported = await this.call<DesignSystemSummary | null>({ action: 'import' });
    await this.refresh(this.linkedFor);
    return imported;
  }
}

export const designSystems = new DesignSystemsStore();
