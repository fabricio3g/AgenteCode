// Runs in the page's own world at document_start: keeps the page's console
// errors and warnings, uncaught exceptions and rejected promises so
// `browser_console` can report what happened before the agent looked.
// Entries carry a sequence number; a read marks everything up to it as seen.

interface Entry {
  seq: number;
  level: 'error' | 'warning';
  source: string;
  text: string;
}

interface Store {
  entries: Entry[];
  next: number;
  seen: number;
}

(() => {
  const w = window as unknown as { __agenteConsole?: Store };
  if (w.__agenteConsole) return;
  const store: Store = { entries: [], next: 1, seen: 0 };
  Object.defineProperty(window, '__agenteConsole', { value: store, enumerable: false });

  const describe = (value: unknown): string => {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const push = (level: Entry['level'], source: string, text: string) => {
    store.entries.push({ seq: store.next++, level, source, text: text.slice(0, 800) });
    if (store.entries.length > 200) store.entries.splice(0, store.entries.length - 200);
  };

  for (const [method, level] of [['error', 'error'], ['warn', 'warning']] as const) {
    const original = console[method];
    console[method] = function (...args: unknown[]) {
      try {
        push(level, 'console', args.map(describe).join(' '));
      } catch {
        /* never break the page's own logging */
      }
      return original.apply(this, args);
    };
  }
  addEventListener('error', (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
    push('error', 'exception', `${event.message}${where}`);
  });
  addEventListener('unhandledrejection', (event) => push('error', 'exception', `Unhandled rejection: ${describe(event.reason)}`));
})();
