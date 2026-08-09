export type AutosaveState = 'idle' | 'saving' | 'saved' | 'blocked' | 'error';

export interface AutosaveSnapshot<T> {
  state: AutosaveState;
  value?: T;
  error?: string;
}

export interface AutosaveController<T> {
  schedule(value: T): void;
  block(message: string, value?: T): void;
  retry(): void;
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutosaveController<T>(
  save: (value: T) => Promise<void>,
  onstate: (snapshot: AutosaveSnapshot<T>) => void,
  delay = 300,
): AutosaveController<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let latestValue: T | undefined;
  let hasValue = false;
  let running = false;
  let disposed = false;

  async function persist(targetRevision: number, value: T) {
    if (disposed) return;
    if (running) return;
    running = true;
    onstate({ state: 'saving', value });
    try {
      await save(value);
      if (targetRevision === revision && !disposed) {
        onstate({ state: 'saved', value });
      }
    } catch (error) {
      if (targetRevision === revision && !disposed) {
        onstate({
          state: 'error',
          value,
          error: error instanceof Error ? error.message : 'Could not save changes',
        });
      }
    } finally {
      running = false;
      if (targetRevision !== revision && hasValue && latestValue !== undefined && !disposed) {
        await persist(revision, latestValue);
      }
    }
  }

  function schedule(value: T) {
    latestValue = value;
    hasValue = true;
    revision += 1;
    if (timer) clearTimeout(timer);
    const targetRevision = revision;
    timer = setTimeout(() => {
      timer = undefined;
      void persist(targetRevision, value);
    }, delay);
  }

  async function flush() {
    if (!hasValue || latestValue === undefined) return;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    revision += 1;
    await persist(revision, latestValue);
  }

  return {
    schedule,
    block(message, value) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (value !== undefined) {
        latestValue = value;
        hasValue = true;
      }
      revision += 1;
      onstate({ state: 'blocked', value: latestValue, error: message });
    },
    retry() {
      if (hasValue && latestValue !== undefined) schedule(latestValue);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      disposed = true;
      revision += 1;
    },
  };
}
