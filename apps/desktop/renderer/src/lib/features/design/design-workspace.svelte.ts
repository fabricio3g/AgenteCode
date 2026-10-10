import type { DesignFiles, DesignVersion } from '$shared/design';

export interface DesignWorkspaceDeps {
  read: (chatId: string) => Promise<DesignFiles>;
  versions: (chatId: string) => Promise<DesignVersion[]>;
}

/** Workspace reads and request ordering; the canvas owns selection and presentation. */
export class DesignWorkspaceController {
  chatId = $state<string | null>(null);
  data = $state.raw<DesignFiles>({ files: {}, pages: [], variants: [] });
  versions = $state.raw<DesignVersion[]>([]);
  loading = $state(false);
  private generation = 0;
  private readSequence = 0;
  private versionSequence = 0;

  constructor(private readonly deps: DesignWorkspaceDeps) {}

  reset(chatId: string | null) {
    this.generation++;
    this.chatId = chatId;
    this.data = { files: {}, pages: [], variants: [] };
    this.versions = [];
    this.loading = false;
  }

  async refresh(): Promise<boolean> {
    const chatId = this.chatId;
    if (!chatId) return false;
    const generation = this.generation;
    const sequence = ++this.readSequence;
    const current = () => generation === this.generation && sequence === this.readSequence;
    this.loading = true;
    try {
      const data = await this.deps.read(chatId);
      if (!current()) return false;
      this.data = data;
      return true;
    } catch {
      // Retain the last readable workspace; a later change retries.
      return false;
    } finally {
      if (current()) this.loading = false;
    }
  }

  async refreshVersions(): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;
    const generation = this.generation;
    const sequence = ++this.versionSequence;
    const versions = await this.deps.versions(chatId).catch(() => []);
    if (generation === this.generation && sequence === this.versionSequence) this.versions = versions;
  }
}
